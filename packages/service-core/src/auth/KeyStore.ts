import { AuthorizationError, ErrorCode, logger } from '@powersync/lib-services-framework';
import * as jose from 'jose';
import secs from '../util/secs.js';
import { JwtPayload } from './JwtPayload.js';
import { KeyCollector } from './KeyCollector.js';
import { KeyOptions, KeySpec, SUPPORTED_ALGORITHMS } from './KeySpec.js';
import { debugKeyNotFound, mapAuthError, SupabaseAuthDetails, tokenDebugDetails } from './utils.js';

/**
 * KeyStore to get keys and verify tokens.
 *
 *
 * Similar to micro_auth's KeyStore, but with different caching and error handling.
 *
 * We generally assume that:
 * 1. If we have a key kid matching a JWT kid, that is the correct key.
 *    We don't look for other keys, even if there are algorithm or other issues.
 * 2. Otherwise, iterate through "wildcard" keys and look for a matching signature.
 *    Wildcard keys are any key defined without a kid.
 *
 * # Security considerations
 *
 * Some places for security holes:
 * 1. Signature verification not done correctly: We rely on jose.jwtVerify() to do this correctly.
 * 2. Using a key that has been revoked - see CachedKeyCollector's refresh strategy.
 * 3. Using a key for the wrong purpose (e.g. key.use != 'sig'). Checked in RemoteJWKSCollector.
 * 4. Not checking all attributes, e.g. a JWT trusted by the global firebase key, but has the wrong aud. Correct aud must be configured.
 * 5. Using the incorrect algorithm, e.g. 'none', or using public key as a shared key.
 *    We check the algorithm for each JWT against the matching key's configured algorithm or algorithm family.
 *
 * # Errors
 *
 * If we have a matching kid, we can generally get a detailed error (e.g. signature verification failed, invalid algorithm, etc).
 * If we don't have a matching kid, we'll generally just get an error "Could not find an appropriate key...".
 */
export class KeyStore<Collector extends KeyCollector = KeyCollector> {
  /**
   * @internal
   */
  collector: Collector;

  /**
   * For debug purposes only.
   *
   * This is very Supabase-specific, but we need the info on this level. For example,
   * we want to detect cases where a Supabase token is used, but Supabase auth is not enabled
   * (no Supabase collector configured).
   */
  supabaseAuthDebug: {
    /**
     * This can be populated without jwksEnabled, but not the other way around.
     */
    jwksDetails: SupabaseAuthDetails | null;
    jwksEnabled: boolean;
    /**
     * This can be enabled without jwksDetails populated.
     */
    sharedSecretEnabled: boolean;
  } = {
    jwksDetails: null,
    jwksEnabled: false,
    sharedSecretEnabled: false
  };

  constructor(collector: Collector) {
    this.collector = collector;
  }

  async verifyJwt(token: string, options: { defaultAudiences: string[]; maxAge: string }): Promise<JwtPayload> {
    const { result, keyOptions } = await this.verifyInternal(token, {
      // audience is not checked here, since we vary the allowed audience based on the key
      // audience: options.defaultAudiences,
      clockTolerance: 60,
      // More specific algorithm checking is done when selecting the key to use.
      algorithms: SUPPORTED_ALGORITHMS,
      // 'aud' presence is checked below, so we can add more details to the error message.
      requiredClaims: ['sub', 'iat', 'exp']
    });

    let audiences = options.defaultAudiences;
    if (keyOptions.requiresAudience) {
      // Replace the audience, don't add
      audiences = keyOptions.requiresAudience;
    }

    const tokenPayload = result.payload;

    let aud = tokenPayload.aud;
    if (aud == null) {
      throw new AuthorizationError(ErrorCode.PSYNC_S2105, `JWT payload is missing a required claim "aud"`, {
        configurationDetails: `Current configuration allows these audience values: ${JSON.stringify(audiences)}`
      });
    } else if (!Array.isArray(aud)) {
      aud = [aud];
    }
    if (
      !aud.some((a) => {
        return audiences.includes(a);
      })
    ) {
      throw new AuthorizationError(
        ErrorCode.PSYNC_S2105,
        `Unexpected "aud" claim value: ${JSON.stringify(tokenPayload.aud)}`,
        { configurationDetails: `Current configuration allows these audience values: ${JSON.stringify(audiences)}` }
      );
    }

    const tokenDuration = tokenPayload.exp! - tokenPayload.iat!;

    // Implement our own maxAge validation, that rejects the token immediately if expiration
    // is too far into the future.
    const maxAge = keyOptions.maxLifetimeSeconds ?? secs(options.maxAge);
    if (tokenDuration > maxAge) {
      throw new AuthorizationError(
        ErrorCode.PSYNC_S2104,
        `Token must expire in a maximum of ${maxAge} seconds, got ${tokenDuration}s`
      );
    }

    const parameters = tokenPayload.parameters;
    if (parameters != null && (Array.isArray(parameters) || typeof parameters != 'object')) {
      throw new AuthorizationError(ErrorCode.PSYNC_S2101, `Payload parameters must be an object`);
    }

    return tokenPayload as JwtPayload;
  }

  private async verifyInternal(token: string, options: jose.JWTVerifyOptions) {
    let keyOptions: KeyOptions | undefined = undefined;
    try {
      const result = await jose.jwtVerify(
        token,
        async (header) => {
          let key = await this.getCachedKey(token, header);
          keyOptions = key.options;
          return key.key;
        },
        options
      );
      return { result, keyOptions: keyOptions! };
    } catch (e) {
      throw mapAuthError(e, token);
    }
  }

  private async getCachedKey(token: string, header: jose.JWTHeaderParameters): Promise<KeySpec> {
    const kid = header.kid;
    const { keys, errors } = await this.collector.getKeys();
    if (kid) {
      // key has kid: JWK with exact kid, or JWK without kid
      // key without kid: JWK without kid only
      for (let key of keys) {
        if (key.kid == kid) {
          if (!key.matchesAlgorithm(header.alg)) {
            throw new AuthorizationError(ErrorCode.PSYNC_S2101, `Unexpected token algorithm ${header.alg}`, {
              configurationDetails: `Key kid: ${key.source.kid}, alg: ${key.source.alg}, kty: ${key.source.kty}`
              // tokenDetails automatically populated higher up the stack
            });
          }
          return key;
        }
      }
    }

    for (let key of keys) {
      // Checks signature and algorithm
      if (key.kid != null) {
        // Not a wildcard key
        continue;
      }
      if (!key.matchesAlgorithm(header.alg)) {
        continue;
      }

      if (await key.isValidSignature(token)) {
        return key;
      }
    }

    if (errors.length > 0) {
      throw errors[0];
    } else {
      // No key found
      // Trigger refresh of the keys - might be ready by the next request.
      this.collector.noKeyFound?.().catch((e) => {
        // Typically this error would be stored on the collector.
        // This is just a last resort error handling.
        logger.error(`Failed to refresh keys`, e);
      });

      const details = debugKeyNotFound(this, keys, token);

      throw new AuthorizationError(
        ErrorCode.PSYNC_S2101,
        'Could not find an appropriate key in the keystore. The key is missing or no key matched the token KID',
        {
          ...details
        }
      );
    }
  }
}
