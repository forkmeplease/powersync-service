import * as http from 'http';
import * as https from 'https';
import * as jose from 'jose';
import fetch from 'node-fetch';

import {
  AuthorizationError,
  ErrorCode,
  LookupOptions,
  makeHostnameLookupFunction,
  ServiceAssertionError,
  ServiceError
} from '@powersync/lib-services-framework';
import { KeyCollector, KeyResult } from './KeyCollector.js';
import { KeyOptions, KeySpec } from './KeySpec.js';

export type RemoteJWKSCollectorOptions = {
  lookupOptions?: LookupOptions;
  keyOptions?: KeyOptions;
};

/**
 * Set of keys fetched from JWKS URI.
 */
export class RemoteJWKSCollector implements KeyCollector {
  private url: URL;
  private agent: http.Agent;
  private keyOptions: KeyOptions;

  constructor(
    url: string,
    protected options?: RemoteJWKSCollectorOptions
  ) {
    try {
      this.url = new URL(url);
    } catch (e: any) {
      throw new ServiceError(ErrorCode.PSYNC_S3102, `Invalid jwks_uri: ${JSON.stringify(url)} Details: ${e.message}`);
    }
    this.keyOptions = options?.keyOptions ?? {};

    // We do support http here for self-hosting use cases.
    // Management service restricts this to https for hosted versions.
    if (this.url.protocol != 'https:' && this.url.protocol != 'http:') {
      throw new ServiceError(
        ErrorCode.PSYNC_S3103,
        `Only http(s) is supported for jwks_uri, got: ${JSON.stringify(url)}`
      );
    }

    this.agent = this.resolveAgent();
  }

  private async getJwksData(): Promise<any> {
    const abortController = new AbortController();
    const REQUEST_TIMEOUT_SECONDS = 30;
    const timeout = setTimeout(() => {
      abortController.abort();
    }, REQUEST_TIMEOUT_SECONDS * 1000);

    try {
      const res = await fetch(this.url, {
        method: 'GET',
        headers: {
          Accept: 'application/json'
        },
        signal: abortController.signal,
        agent: this.agent
      });

      if (!res.ok) {
        throw new AuthorizationError(ErrorCode.PSYNC_S2204, `JWKS request failed with ${res.statusText}`, {
          configurationDetails: `JWKS URL: ${this.url}`
        });
      }

      return (await res.json()) as any;
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        e = { message: `Request timed out in ${REQUEST_TIMEOUT_SECONDS}s`, name: 'AbortError' };
      }
      throw new AuthorizationError(ErrorCode.PSYNC_S2204, `JWKS request failed`, {
        configurationDetails: `JWKS URL: ${this.url}`,
        // This covers most cases of FetchError
        // `cause: e` could lose the error message
        cause: { message: e.message, code: e.code, name: e.name }
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async getKeys(): Promise<KeyResult> {
    const data = await this.getJwksData();

    // https://github.com/panva/jose/blob/358e864a0cccf1e0f9928a959f91f18f3f06a7de/src/jwks/local.ts#L36
    if (
      data.keys == null ||
      !Array.isArray(data.keys) ||
      !(data.keys as any[]).every((key) => typeof key == 'object' && !Array.isArray(key))
    ) {
      return {
        keys: [],
        errors: [
          new AuthorizationError(ErrorCode.PSYNC_S2204, `Invalid JWKS response`, {
            configurationDetails: `JWKS URL: ${this.url}. Response:\n${JSON.stringify(data, null, 2)}`
          })
        ]
      };
    }

    let keys: KeySpec[] = [];
    for (let keyData of data.keys) {
      if (keyData.kty != 'RSA' && keyData.kty != 'OKP' && keyData.kty != 'EC') {
        // HS (oct) keys not allowed because they are symmetric
        continue;
      }

      if (typeof keyData.use == 'string') {
        if (keyData.use != 'sig') {
          continue;
        }
      }
      if (Array.isArray(keyData.key_ops)) {
        if (!keyData.key_ops.includes('verify')) {
          continue;
        }
      }

      const key = await KeySpec.importKey(keyData, this.keyOptions);
      keys.push(key);
    }

    return { keys: keys, errors: [] };
  }

  /**
   * Agent that uses a custom lookup function.
   *
   * This will synchronously raise an error if the URL contains an IP in the reject list.
   * For domain names resolving to a rejected IP, that will fail when making the request.
   */
  resolveAgent(): http.Agent | https.Agent {
    const lookupOptions = this.options?.lookupOptions ?? { reject_ip_ranges: [] };
    const lookup = makeHostnameLookupFunction(this.url.hostname, lookupOptions);

    const options: http.AgentOptions = {
      lookup
    };

    switch (this.url.protocol) {
      case 'http:':
        return new http.Agent(options);
      case 'https:':
        return new https.Agent(options);
    }
    // Already validated the URL before, so this is not expected
    throw new ServiceAssertionError('http or or https is required for JWKS protocol');
  }
}
