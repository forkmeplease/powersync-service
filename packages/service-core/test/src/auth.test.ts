import { describe, expect, test } from 'vitest';
import { StaticKeyCollector } from '../../src/auth/StaticKeyCollector.js';
import * as jose from 'jose';
import { KeyStore } from '../../src/auth/KeyStore.js';
import { KeySpec } from '../../src/auth/KeySpec.js';
import { RemoteJWKSCollector } from '../../src/auth/RemoteJWKSCollector.js';
import { KeyResult } from '../../src/auth/KeyCollector.js';
import { CachedKeyCollector } from '../../src/auth/CachedKeyCollector.js';
import { JwtPayload, StaticSupabaseKeyCollector } from '@/index.js';
import { debugKeyNotFound } from '../../src/auth/utils.js';

const publicKeyRSA: jose.JWK = {
  use: 'sig',
  kty: 'RSA',
  e: 'AQAB',
  kid: 'f2e82732b971a135cf1416e8b46dae04d80894e7',
  alg: 'RS256',
  n: 'v7wW9w5vzvACxbo2Ldqt0IHBy0LCloQvnfIr-nhEKmqgBJeBgF2cZSGz0Fe-grRaAvhhDrxaOft2JvZlbUM8vFFnxx-52dYViDBxv8vDxmV1HeEGV69DYrGxnsOLrHQWKkPSeyxtidiwGrNVYuyC21PG1heScTYppxVSHBUh_D9di56ql16Xytv97FJHeBtEYUmyzLQsWGhfzuLBwYSSuZxia4p3-azlztHisht4Ai1KYpX0HWLjh9NGIMzimk2cNdKZjIO1Mm4Tu5S1z9dCauZdocpE5csFHyeLHY3oeXFNgl9GanyM9IAg-0T5QLJA-C6M9lUO4WuVmOtLM_iGlw'
};

const sharedKey: jose.JWK = {
  kid: 'k1',
  alg: 'HS256',
  kty: 'oct',
  k: Buffer.from('mysecret1', 'utf-8').toString('base64url')
};

const sharedKey2: jose.JWK = {
  alg: 'HS256',
  kty: 'oct',
  k: Buffer.from('mysecret2', 'utf-8').toString('base64url')
};

const privateKeyEdDSA: jose.JWK = {
  use: 'sig',
  kty: 'OKP',
  crv: 'Ed25519',
  kid: 'k2',
  x: 'nfaqgxakPaiiEdAtRGrubgh_SQ1mr6gAUx3--N-ehvo',
  d: 'wweBqMbTrME6oChSEMYAOyYzxsGisQb-C1t0XMjb_Ng',
  alg: 'EdDSA'
};

const privateKeyECDSA: jose.JWK = {
  use: 'sig',
  kty: 'EC',
  crv: 'P-256',
  kid: 'k3',
  x: 'Y37HQjG1YvlQZ16CzO7UQxgkY_us-NfPxMPcHUDN-PE',
  y: 'W3Jqs5_qlIh2UH79l8L3ApqNu14aFetM5oc9oCjAEaw',
  d: 'p2HQaJApdgaAemVuVsL1hscCFOTd0r9uGxRnzvAelFU',
  alg: 'ES256'
};

describe('JWT Auth', () => {
  test('KeyStore basics', async () => {
    const keys = await StaticKeyCollector.importKeys([sharedKey]);
    const store = new KeyStore(keys);
    const signKey = (await jose.importJWK(sharedKey)) as jose.KeyLike;
    const signedJwt = await new jose.SignJWT({})
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setSubject('f1')
      .setIssuedAt()
      .setIssuer('tester')
      .setAudience('tests')
      .setExpirationTime('5m')
      .sign(signKey);

    const verified = await store.verifyJwt(signedJwt, {
      defaultAudiences: ['tests'],
      maxAge: '6m'
    });
    expect(verified.sub).toEqual('f1');
    await expect(
      store.verifyJwt(signedJwt, {
        defaultAudiences: ['other'],
        maxAge: '6m'
      })
    ).rejects.toThrow('[PSYNC_S2105] Unexpected "aud" claim value: "tests"');

    await expect(
      store.verifyJwt(signedJwt, {
        defaultAudiences: [],
        maxAge: '6m'
      })
    ).rejects.toThrow('[PSYNC_S2105] Unexpected "aud" claim value: "tests"');

    await expect(
      store.verifyJwt(signedJwt, {
        defaultAudiences: ['tests'],
        maxAge: '1m'
      })
    ).rejects.toThrow('[PSYNC_S2104] Token must expire in a maximum of 60 seconds, got 300s');

    const signedJwt2 = await new jose.SignJWT({})
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setIssuedAt()
      .setIssuer('tester')
      .setAudience('tests')
      .setExpirationTime('5m')
      .sign(signKey);

    await expect(
      store.verifyJwt(signedJwt2, {
        defaultAudiences: ['tests'],
        maxAge: '5m'
      })
    ).rejects.toThrow('[PSYNC_S2101] JWT payload is missing a required claim "sub"');

    // expired token
    const d = Math.round(Date.now() / 1000);
    const signedJwt3 = await new jose.SignJWT({})
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setSubject('f1')
      .setIssuedAt(d - 500)
      .setIssuer('tester')
      .setAudience('tests')
      .setExpirationTime(d - 400)
      .sign(signKey);

    await expect(
      store.verifyJwt(signedJwt3, {
        defaultAudiences: ['tests'],
        maxAge: '5m'
      })
    ).rejects.toThrow('[PSYNC_S2103] JWT has expired');
  });

  test('Algorithm validation', async () => {
    const keys = await StaticKeyCollector.importKeys([publicKeyRSA]);
    const store = new KeyStore(keys);

    // Bad attempt at signing token with rsa public key
    const spoofedKey: jose.JWK = {
      kty: 'oct',
      kid: publicKeyRSA.kid!,
      alg: 'HS256',
      k: publicKeyRSA.n!
    };
    const signKey = (await jose.importJWK(spoofedKey)) as jose.KeyLike;

    const signedJwt = await new jose.SignJWT({})
      .setProtectedHeader({ alg: 'HS256', kid: publicKeyRSA.kid! })
      .setSubject('f1')
      .setIssuedAt()
      .setIssuer('tester')
      .setAudience('tests')
      .setExpirationTime('5m')
      .sign(signKey);

    await expect(
      store.verifyJwt(signedJwt, {
        defaultAudiences: ['tests'],
        maxAge: '6m'
      })
    ).rejects.toThrow('Unexpected token algorithm HS256');
  });

  test('key selection for key with kid', async () => {
    const keys = await StaticKeyCollector.importKeys([publicKeyRSA, sharedKey, sharedKey2]);
    const store = new KeyStore(keys);
    const signKey = (await jose.importJWK(sharedKey)) as jose.KeyLike;
    const signKey2 = (await jose.importJWK(sharedKey2)) as jose.KeyLike;

    // No kid
    const signedJwt = await new jose.SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('f1')
      .setIssuedAt()
      .setIssuer('tester')
      .setAudience('tests')
      .setExpirationTime('5m')
      .sign(signKey);

    await expect(
      store.verifyJwt(signedJwt, {
        defaultAudiences: ['tests'],
        maxAge: '6m'
      })
    ).rejects.toThrow(
      '[PSYNC_S2101] Could not find an appropriate key in the keystore. The key is missing or no key matched the token KID'
    );

    // Wrong kid
    const signedJwt2 = await new jose.SignJWT({})
      .setProtectedHeader({ alg: 'HS256', kid: 'other' })
      .setSubject('f1')
      .setIssuedAt()
      .setIssuer('tester')
      .setAudience('tests')
      .setExpirationTime('5m')
      .sign(signKey);

    await expect(
      store.verifyJwt(signedJwt2, {
        defaultAudiences: ['tests'],
        maxAge: '6m'
      })
    ).rejects.toThrow(
      '[PSYNC_S2101] Could not find an appropriate key in the keystore. The key is missing or no key matched the token KID'
    );

    // No kid, matches sharedKey2
    const signedJwt3 = await new jose.SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('f1')
      .setIssuedAt()
      .setIssuer('tester')
      .setAudience('tests')
      .setExpirationTime('5m')
      .sign(signKey2);

    await expect(
      store.verifyJwt(signedJwt3, {
        defaultAudiences: ['tests'],
        maxAge: '6m'
      })
    ).resolves.toMatchObject({ sub: 'f1' });

    // Random kid, matches sharedKey2
    const signedJwt4 = await new jose.SignJWT({})
      .setProtectedHeader({ alg: 'HS256', kid: 'other' })
      .setSubject('f1')
      .setIssuedAt()
      .setIssuer('tester')
      .setAudience('tests')
      .setExpirationTime('5m')
      .sign(signKey2);

    await expect(
      store.verifyJwt(signedJwt4, {
        defaultAudiences: ['tests'],
        maxAge: '6m'
      })
    ).resolves.toMatchObject({ sub: 'f1' });
  });

  test('KeyOptions', async () => {
    const keys = new StaticKeyCollector([
      await KeySpec.importKey(sharedKey, {
        // This overrides the default validation options
        requiresAudience: ['other'],
        maxLifetimeSeconds: 3600
      })
    ]);
    const store = new KeyStore(keys);
    const signKey = (await jose.importJWK(sharedKey)) as jose.KeyLike;
    const signedJwt = await new jose.SignJWT({})
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setSubject('f1')
      .setIssuedAt()
      .setIssuer('tester')
      .setAudience('other')
      .setExpirationTime('50m')
      .sign(signKey);

    const verified = await store.verifyJwt(signedJwt, {
      defaultAudiences: ['tests'],
      maxAge: '6m'
    });
    expect(verified.sub).toEqual('f1');

    const signedJwt2 = await new jose.SignJWT({})
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setSubject('f1')
      .setIssuedAt()
      .setIssuer('tester')
      .setAudience('tests') // Doesn't match KeyOptions audience
      .setExpirationTime('50m')
      .sign(signKey);

    await expect(
      store.verifyJwt(signedJwt2, {
        defaultAudiences: ['tests'],
        maxAge: '6m'
      })
    ).rejects.toThrow('[PSYNC_S2105] Unexpected "aud" claim value: "tests"');

    const signedJwt3 = await new jose.SignJWT({})
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setSubject('f1')
      .setIssuedAt()
      .setIssuer('tester')
      .setAudience('other')
      .setExpirationTime('70m') // longer than KeyOptions expiration
      .sign(signKey);

    await expect(
      store.verifyJwt(signedJwt3, {
        defaultAudiences: ['tests'],
        maxAge: '6m'
      })
    ).rejects.toThrow('Token must expire in a maximum of');
  });

  test('http', { timeout: 20_000 }, async () => {
    // Not ideal to rely on an external endpoint for tests, but it is good to test that this
    // one actually works.
    const remote = new RemoteJWKSCollector(
      'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
    );
    const { keys, errors } = await remote.getKeys();
    expect(errors).toEqual([]);
    expect(keys.length).toBeGreaterThanOrEqual(1);

    // Domain names are resolved when retrieving keys
    const invalid = new RemoteJWKSCollector('https://localhost/.well-known/jwks.json', {
      lookupOptions: {
        reject_ip_ranges: ['local']
      }
    });
    await expect(invalid.getKeys()).rejects.toThrow('[PSYNC_S2204] JWKS request failed');

    // IPs throw an error immediately
    expect(
      () =>
        new RemoteJWKSCollector('https://127.0.0.1/.well-known/jwks.json', {
          lookupOptions: {
            reject_ip_ranges: ['local']
          }
        })
    ).toThrowError('IPs in this range are not supported');
  });

  test('http not blocking local IPs', async () => {
    // Not ideal to rely on an external endpoint for tests, but it is good to test that this
    // one actually works.
    const remote = new RemoteJWKSCollector(
      'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
    );
    const { keys, errors } = await remote.getKeys();
    expect(errors).toEqual([]);
    expect(keys.length).toBeGreaterThanOrEqual(1);

    const invalid = new RemoteJWKSCollector('https://127.0.0.1/.well-known/jwks.json');
    // Should try and fetch
    await expect(invalid.getKeys()).rejects.toThrow();

    const invalid2 = new RemoteJWKSCollector('https://localhost/.well-known/jwks.json');
    // Should try and fetch
    await expect(invalid2.getKeys()).rejects.toThrow();
  });

  test('caching', async () => {
    let currentResponse: Promise<KeyResult>;

    const cached = new CachedKeyCollector({
      async getKeys() {
        return currentResponse;
      }
    });

    currentResponse = Promise.resolve({
      errors: [],
      keys: [await KeySpec.importKey(publicKeyRSA)]
    });

    let key = (await cached.getKeys()).keys[0];
    expect(key.kid).toEqual(publicKeyRSA.kid!);

    currentResponse = undefined as any;

    key = (await cached.getKeys()).keys[0];
    expect(key.kid).toEqual(publicKeyRSA.kid!);

    cached.addTimeForTests(301_000);
    currentResponse = Promise.reject(new Error('refresh failed'));

    // Uses the promise, refreshes in the background
    let response = await cached.getKeys();
    expect(response.keys[0].kid).toEqual(publicKeyRSA.kid!);
    expect(response.errors).toEqual([]);

    // Wait for refresh to finish
    await cached.addTimeForTests(0);
    response = await cached.getKeys();
    // Still have the cached key, but also have the error
    expect(response.keys[0].kid).toEqual(publicKeyRSA.kid!);
    expect(response.errors[0].message).toMatch('[PSYNC_S2201] refresh failed');

    await cached.addTimeForTests(3601_000);
    response = await cached.getKeys();

    // Now the keys have expired, and the request still fails
    expect(response.keys).toEqual([]);
    expect(response.errors[0].message).toMatch('[PSYNC_S2201] refresh failed');

    currentResponse = Promise.resolve({
      errors: [],
      keys: [await KeySpec.importKey(publicKeyRSA)]
    });

    // After a delay, we can refresh again
    await cached.addTimeForTests(30_000);
    key = (await cached.getKeys()).keys[0];
    expect(key.kid).toEqual(publicKeyRSA.kid!);
  });

  test('signing with EdDSA', async () => {
    const keys = await StaticKeyCollector.importKeys([privateKeyEdDSA]);
    const store = new KeyStore(keys);
    const signKey = (await jose.importJWK(privateKeyEdDSA)) as jose.KeyLike;

    const signedJwt = await new jose.SignJWT({ claim: 'test-claim' })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'k2' })
      .setSubject('f1')
      .setIssuedAt()
      .setIssuer('tester')
      .setAudience('tests')
      .setExpirationTime('5m')
      .sign(signKey);

    const verified = (await store.verifyJwt(signedJwt, {
      defaultAudiences: ['tests'],
      maxAge: '6m'
    })) as JwtPayload & { claim: string };

    expect(verified.claim).toEqual('test-claim');
  });

  test('signing with ECDSA', async () => {
    const keys = await StaticKeyCollector.importKeys([privateKeyECDSA]);
    const store = new KeyStore(keys);
    const signKey = (await jose.importJWK(privateKeyECDSA)) as jose.KeyLike;

    const signedJwt = await new jose.SignJWT({ claim: 'test-claim-2' })
      .setProtectedHeader({ alg: 'ES256', kid: 'k3' })
      .setSubject('f1')
      .setIssuedAt()
      .setIssuer('tester')
      .setAudience('tests')
      .setExpirationTime('5m')
      .sign(signKey);

    const verified = (await store.verifyJwt(signedJwt, {
      defaultAudiences: ['tests'],
      maxAge: '6m'
    })) as JwtPayload & { claim: string };

    expect(verified.claim).toEqual('test-claim-2');
  });

  describe('debugKeyNotFound', () => {
    test('Supabase token with legacy auth not configured', async () => {
      const keys = await StaticSupabaseKeyCollector.importKeys([]);
      const store = new KeyStore(keys);

      // Mock Supabase debug info - legacy not enabled
      store.supabaseAuthDebug = {
        jwksDetails: null,
        jwksEnabled: false,
        sharedSecretEnabled: false
      };

      // Create a legacy Supabase token (HS256)
      const token = await new jose.SignJWT({})
        .setProtectedHeader({ alg: 'HS256', kid: 'test' })
        .setSubject('test')
        .setIssuer('https://abc123.supabase.co/auth/v1')
        .setAudience('authenticated')
        .setExpirationTime('1h')
        .setIssuedAt()
        .sign(Buffer.from('secret'));

      const err = await store.verifyJwt(token, { defaultAudiences: [], maxAge: '1d' }).catch((e) => e);
      expect(err.configurationDetails).toMatch(
        'Token is a Supabase Legacy HS256 (Shared Secret) token, but Supabase JWT secret is not configured'
      );
    });

    test('Legacy Supabase token with wrong secret', async () => {
      const keys = await StaticSupabaseKeyCollector.importKeys([sharedKey]);
      const store = new KeyStore(keys);

      // Mock Supabase debug info - legacy enabled
      store.supabaseAuthDebug = {
        jwksDetails: null,
        jwksEnabled: false,
        sharedSecretEnabled: true
      };

      // Create a legacy Supabase token (HS256)
      const token = await new jose.SignJWT({})
        .setProtectedHeader({ alg: 'HS256', kid: sharedKey2.kid })
        .setSubject('test')
        .setIssuer('https://abc123.supabase.co/auth/v1')
        .setAudience('authenticated')
        .setExpirationTime('1h')
        .setIssuedAt()
        .sign(await jose.importJWK(sharedKey2));

      const err = await store.verifyJwt(token, { defaultAudiences: [], maxAge: '1d' }).catch((e) => e);
      expect(err.configurationDetails).toMatch(
        'Token is a Supabase Legacy HS256 (Shared Secret) token, but configured Supabase JWT secret does not match'
      );
    });

    test('New HS256 Supabase token with wrong secret', async () => {
      const keys = await StaticSupabaseKeyCollector.importKeys([sharedKey]);
      const store = new KeyStore(keys);

      // Mock Supabase debug info - legacy enabled
      store.supabaseAuthDebug = {
        jwksDetails: null,
        jwksEnabled: false,
        sharedSecretEnabled: true
      };

      // Create a new HS256 Supabase token.
      // The only real difference here is that the kid is a UUID
      const token = await new jose.SignJWT({})
        .setProtectedHeader({ alg: 'HS256', kid: '2fc01f1d-90fb-4c8b-b646-1c06ed86be46' })
        .setSubject('test')
        .setIssuer('https://abc123.supabase.co/auth/v1')
        .setAudience('authenticated')
        .setExpirationTime('1h')
        .setIssuedAt()
        .sign(await jose.importJWK(sharedKey2));

      const err = await store.verifyJwt(token, { defaultAudiences: [], maxAge: '1d' }).catch((e) => e);
      expect(err.configurationDetails).toMatch(
        'Token is a Supabase HS256 (Shared Secret) token, but configured Supabase JWT secret does not match'
      );
    });

    test('Supabase signing key token with no Supabase connection', async () => {
      const keys = await StaticSupabaseKeyCollector.importKeys([]);
      const store = new KeyStore(keys);

      // Mock Supabase debug info - no Supabase connection
      store.supabaseAuthDebug = {
        jwksDetails: null,
        jwksEnabled: false,
        sharedSecretEnabled: false
      };

      const signKey = await jose.importJWK(privateKeyECDSA);
      const token = await new jose.SignJWT({})
        .setProtectedHeader({ alg: 'ES256', kid: 'test-kid' })
        .setSubject('test')
        .setIssuer('https://abc123.supabase.co/auth/v1')
        .setAudience('authenticated')
        .setExpirationTime('1h')
        .setIssuedAt()
        .sign(signKey);

      const err = await store.verifyJwt(token, { defaultAudiences: [], maxAge: '1d' }).catch((e) => e);
      expect(err.configurationDetails).toMatch(
        'Token uses Supabase JWT Signing Keys, but no Supabase connection is configured'
      );
    });

    test('Supabase signing key token with Supabase auth disabled', async () => {
      const keys = await StaticSupabaseKeyCollector.importKeys([]);
      const store = new KeyStore(keys);

      // Mock Supabase debug info - Supabase project, but Supabase auth not enabled
      store.supabaseAuthDebug = {
        jwksDetails: {
          projectId: 'abc123',
          hostname: 'db.abc123.supabase.co',
          url: 'https://abc123.supabase.co/auth/v1/.well-known/jwks.json'
        },
        jwksEnabled: false,
        sharedSecretEnabled: false
      };

      const signKey = await jose.importJWK(privateKeyECDSA);
      const token = await new jose.SignJWT({})
        .setProtectedHeader({ alg: 'ES256', kid: 'test-kid' })
        .setSubject('test')
        .setIssuer('https://abc123.supabase.co/auth/v1')
        .setAudience('authenticated')
        .setExpirationTime('1h')
        .setIssuedAt()
        .sign(signKey);

      const err = await store.verifyJwt(token, { defaultAudiences: [], maxAge: '1d' }).catch((e) => e);
      expect(err.configurationDetails).toMatch(
        'Token uses Supabase JWT Signing Keys, but Supabase Auth is not enabled'
      );
    });

    test('Supabase project ID mismatch', async () => {
      const keys = await StaticSupabaseKeyCollector.importKeys([publicKeyRSA]);
      const store = new KeyStore(keys);

      // Mock Supabase debug info - JWKS enabled with different project ID
      store.supabaseAuthDebug = {
        jwksDetails: {
          projectId: 'expected123',
          hostname: 'db.expected123.supabase.co',
          url: 'https://expected123.supabase.co/auth/v1/.well-known/jwks.json'
        },
        jwksEnabled: true,
        sharedSecretEnabled: false
      };

      // Create a modern Supabase token with different project ID
      const token = await new jose.SignJWT({})
        .setProtectedHeader({ alg: 'ES256', kid: privateKeyECDSA.kid })
        .setSubject('test')
        .setIssuer('https://different456.supabase.co/auth/v1')
        .setAudience('authenticated')
        .setExpirationTime('1h')
        .setIssuedAt()
        .sign(await jose.importJWK(privateKeyECDSA));

      const err = await store.verifyJwt(token, { defaultAudiences: [], maxAge: '1d' }).catch((e) => e);
      expect(err.configurationDetails).toMatch(
        'Supabase project id mismatch. Expected project: expected123, got issuer: https://different456.supabase.co/auth/v1'
      );
    });

    test('Supabase signing keys configured but no matching keys', async () => {
      const keys = await StaticSupabaseKeyCollector.importKeys([publicKeyRSA]);
      const store = new KeyStore(keys);

      // Mock Supabase debug info - JWKS enabled with matching project ID
      store.supabaseAuthDebug = {
        jwksDetails: {
          projectId: 'abc123',
          hostname: 'db.abc123.supabase.co',
          url: 'https://abc123.supabase.co/auth/v1/.well-known/jwks.json'
        },
        jwksEnabled: true,
        sharedSecretEnabled: false
      };

      // Create a modern Supabase token with matching project ID
      const token = await new jose.SignJWT({})
        .setProtectedHeader({ alg: 'ES256', kid: privateKeyECDSA.kid })
        .setSubject('test')
        .setIssuer('https://abc123.supabase.co/auth/v1')
        .setAudience('authenticated')
        .setExpirationTime('1h')
        .setIssuedAt()
        .sign(await jose.importJWK(privateKeyECDSA));

      const err = await store.verifyJwt(token, { defaultAudiences: [], maxAge: '1d' }).catch((e) => e);
      expect(err.configurationDetails).toMatch(
        'Supabase signing keys configured, but no matching keys found. Known keys: '
      );
    });

    test('non-Supabase token', async () => {
      const keys = await StaticSupabaseKeyCollector.importKeys([sharedKey]);
      const store = new KeyStore(keys);

      // Create a regular JWT token (not Supabase)
      const token = await new jose.SignJWT({})
        .setProtectedHeader({ alg: 'ES256', kid: privateKeyECDSA.kid })
        .setSubject('test')
        .setIssuer('https://regular-issuer.com')
        .setAudience('my-audience')
        .setExpirationTime('1h')
        .setIssuedAt()
        .sign(await jose.importJWK(privateKeyECDSA));

      // Treated as just a generic unknown key
      const err = await store.verifyJwt(token, { defaultAudiences: ['my-audience'], maxAge: '1d' }).catch((e) => e);
      expect(err.configurationDetails).toMatch('Known keys:');
    });

    test('Valid legacy Supabase token', async () => {
      const keys = await StaticSupabaseKeyCollector.importKeys([sharedKey]);
      const store = new KeyStore(keys);

      // Mock Supabase debug info - legacy enabled
      store.supabaseAuthDebug = {
        jwksDetails: null,
        jwksEnabled: false,
        sharedSecretEnabled: true
      };

      // Create a legacy Supabase token (HS256)
      const token = await new jose.SignJWT({})
        .setProtectedHeader({ alg: 'HS256', kid: sharedKey.kid })
        .setSubject('test')
        .setIssuer('https://abc123.supabase.co/auth/v1')
        .setAudience('authenticated')
        .setExpirationTime('1h')
        .setIssuedAt()
        .sign(await jose.importJWK(sharedKey));

      await store.verifyJwt(token, { defaultAudiences: [], maxAge: '1d' });
    });

    test('Valid Supabase signing key', async () => {
      const keys = await StaticSupabaseKeyCollector.importKeys([privateKeyECDSA]);
      const store = new KeyStore(keys);

      // Mock Supabase debug info - JWKS enabled, legacy disabled
      store.supabaseAuthDebug = {
        jwksDetails: null,
        jwksEnabled: true,
        sharedSecretEnabled: false
      };

      // Create a modern Supabase signing key token (ES256)
      const token = await new jose.SignJWT({})
        .setProtectedHeader({ alg: 'ES256', kid: privateKeyECDSA.kid })
        .setSubject('test')
        .setIssuer('https://abc123.supabase.co/auth/v1')
        .setAudience('authenticated')
        .setExpirationTime('1h')
        .setIssuedAt()
        .sign(await jose.importJWK(privateKeyECDSA));

      await store.verifyJwt(token, { defaultAudiences: [], maxAge: '1d' });
    });

    test('Legacy Supabase anon token', async () => {
      const keys = await StaticSupabaseKeyCollector.importKeys([sharedKey]);
      const store = new KeyStore(keys);

      // Mock Supabase debug info - legacy enabled
      store.supabaseAuthDebug = {
        jwksDetails: null,
        jwksEnabled: false,
        sharedSecretEnabled: true
      };

      // Create a legacy Supabase token (HS256)
      const token = await new jose.SignJWT({})
        .setProtectedHeader({ alg: 'HS256', kid: sharedKey.kid })
        .setSubject('test')
        .setIssuer('https://abc123.supabase.co/auth/v1')
        .setAudience('anon')
        .setExpirationTime('1h')
        .setIssuedAt()
        .sign(await jose.importJWK(sharedKey));

      const err = await store.verifyJwt(token, { defaultAudiences: [], maxAge: '1d' }).catch((e) => e);
      expect(err.message).toMatch('[PSYNC_S2105] Unexpected "aud" claim value: "anon"');
    });

    test('Supabase signing key anon token', async () => {
      const keys = await StaticSupabaseKeyCollector.importKeys([privateKeyECDSA]);
      const store = new KeyStore(keys);

      // Mock Supabase debug info - JWKS enabled
      store.supabaseAuthDebug = {
        jwksDetails: null,
        jwksEnabled: true,
        sharedSecretEnabled: false
      };

      // Create a modern Supabase signing key token (ES256)
      const token = await new jose.SignJWT({})
        .setProtectedHeader({ alg: 'ES256', kid: privateKeyECDSA.kid })
        .setSubject('test')
        .setIssuer('https://abc123.supabase.co/auth/v1')
        .setAudience('anon')
        .setExpirationTime('1h')
        .setIssuedAt()
        .sign(await jose.importJWK(privateKeyECDSA));

      const err = await store.verifyJwt(token, { defaultAudiences: [], maxAge: '1d' }).catch((e) => e);
      expect(err.message).toMatch('[PSYNC_S2105] Unexpected "aud" claim value: "anon"');
    });
  });
});
