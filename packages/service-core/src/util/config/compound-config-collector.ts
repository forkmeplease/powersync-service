import { logger, LookupOptions } from '@powersync/lib-services-framework';
import { configFile } from '@powersync/service-types';
import * as auth from '../../auth/auth-index.js';
import { ConfigCollector } from './collectors/config-collector.js';
import { Base64ConfigCollector } from './collectors/impl/base64-config-collector.js';
import { FallbackConfigCollector } from './collectors/impl/fallback-config-collector.js';
import { FileSystemConfigCollector } from './collectors/impl/filesystem-config-collector.js';
import {
  DEFAULT_MAX_BUCKETS_PER_CONNECTION,
  DEFAULT_MAX_CONCURRENT_CONNECTIONS,
  DEFAULT_MAX_DATA_FETCH_CONCURRENCY,
  DEFAULT_MAX_PARAMETER_QUERY_RESULTS,
  DEFAULT_MAX_POOL_SIZE
} from './defaults.js';
import { Base64SyncRulesCollector } from './sync-rules/impl/base64-sync-rules-collector.js';
import { FileSystemSyncRulesCollector } from './sync-rules/impl/filesystem-sync-rules-collector.js';
import { InlineSyncRulesCollector } from './sync-rules/impl/inline-sync-rules-collector.js';
import { SyncRulesCollector } from './sync-rules/sync-collector.js';
import { ResolvedPowerSyncConfig, RunnerConfig, SyncRulesConfig } from './types.js';

export type CompoundConfigCollectorOptions = {
  /**
   * Collectors for PowerSync configuration content.
   * The configuration from first collector to provide a configuration
   * is used. The order of the collectors specifies precedence
   */
  configCollectors: ConfigCollector[];
  /**
   * Collectors for PowerSync sync rules content.
   * The configuration from first collector to provide a configuration
   * is used. The order of the collectors specifies precedence
   */
  syncRulesCollectors: SyncRulesCollector[];
};

export type ConfigCollectedEvent = {
  base_config: configFile.PowerSyncConfig;
  resolved_config: ResolvedPowerSyncConfig;
};

export type ConfigCollectorListener = {
  configCollected?: (event: ConfigCollectedEvent) => Promise<void>;
};

const DEFAULT_COLLECTOR_OPTIONS: CompoundConfigCollectorOptions = {
  configCollectors: [new Base64ConfigCollector(), new FileSystemConfigCollector(), new FallbackConfigCollector()],
  syncRulesCollectors: [
    new Base64SyncRulesCollector(),
    new FileSystemSyncRulesCollector(),
    new InlineSyncRulesCollector()
  ]
};

export class CompoundConfigCollector {
  constructor(protected options: CompoundConfigCollectorOptions = DEFAULT_COLLECTOR_OPTIONS) {}

  /**
   * Collects and resolves base config
   */
  async collectConfig(runnerConfig: RunnerConfig = {}): Promise<ResolvedPowerSyncConfig> {
    const baseConfig = await this.collectBaseConfig(runnerConfig);

    const dataSources = baseConfig.replication?.connections ?? [];
    if (dataSources.length > 1) {
      throw new Error('Only a single replication data source is supported currently');
    }

    const collectors = new auth.CompoundKeyCollector();
    const keyStore = new auth.KeyStore(collectors);

    const inputKeys = baseConfig.client_auth?.jwks?.keys ?? [];
    const staticCollector = await auth.StaticKeyCollector.importKeys(inputKeys);
    collectors.add(staticCollector);

    if (baseConfig.client_auth?.supabase && baseConfig.client_auth?.supabase_jwt_secret != null) {
      // This replaces the old SupabaseKeyCollector, with a statically-configured key.
      // You can get the same effect with manual HS256 key configuration, but this
      // makes the config simpler.
      // We also a custom audience ("authenticated"), increased max lifetime (1 week),
      // and auto base64-url-encode the key.
      collectors.add(
        await auth.StaticSupabaseKeyCollector.importKeys([
          {
            kty: 'oct',
            alg: 'HS256',
            // In this case, the key is not base64-encoded yet.
            k: Buffer.from(baseConfig.client_auth.supabase_jwt_secret, 'utf8').toString('base64url'),
            kid: undefined // Wildcard kid - any kid can match
          }
        ])
      );
      keyStore.supabaseAuthDebug.sharedSecretEnabled = true;
    }

    let jwks_uris = baseConfig.client_auth?.jwks_uri ?? [];
    if (typeof jwks_uris == 'string') {
      jwks_uris = [jwks_uris];
    }

    let jwksLookup: LookupOptions = {
      reject_ip_ranges: []
    };

    if (baseConfig.client_auth?.jwks_reject_ip_ranges != null) {
      jwksLookup = {
        reject_ip_ranges: baseConfig.client_auth?.jwks_reject_ip_ranges
      };
    }
    if (baseConfig.client_auth?.block_local_jwks) {
      // Deprecated - recommend method is to use jwks_reject_ip_ranges
      jwksLookup.reject_ip_ranges.push('local');
      jwksLookup.reject_ipv6 = true;
    }

    for (let uri of jwks_uris) {
      collectors.add(new auth.CachedKeyCollector(new auth.RemoteJWKSCollector(uri, { lookupOptions: jwksLookup })));
    }
    const supabaseAuthDetails = auth.getSupabaseJwksUrl(baseConfig.replication?.connections?.[0]);
    keyStore.supabaseAuthDebug.jwksDetails = supabaseAuthDetails;

    if (baseConfig.client_auth?.supabase) {
      // Automatic support for Supabase signing keys:
      // https://supabase.com/docs/guides/auth/signing-keys
      if (supabaseAuthDetails != null) {
        const collector = new auth.RemoteJWKSCollector(supabaseAuthDetails.url, {
          lookupOptions: jwksLookup,
          // Special case aud and max lifetime for Supabase keys
          keyOptions: auth.SUPABASE_KEY_OPTIONS
        });
        collectors.add(new auth.CachedKeyCollector(collector));
        keyStore.supabaseAuthDebug.jwksEnabled = true;
        logger.info(`Configured Supabase Auth with ${supabaseAuthDetails.url}`);
      } else {
        logger.warn(
          'Supabase Auth is enabled, but no Supabase connection string found. Skipping Supabase JWKS URL configuration.'
        );
      }
    } else if (supabaseAuthDetails != null) {
      logger.warn(`Supabase connection string found, but Supabase Auth is not enabled in the config.`);
    }

    const sync_rules = await this.collectSyncRules(baseConfig, runnerConfig);

    let jwt_audiences: string[] = baseConfig.client_auth?.audience ?? [];

    let config: ResolvedPowerSyncConfig = {
      base_config: baseConfig,
      connections: baseConfig.replication?.connections || [],
      storage: {
        ...baseConfig.storage,
        parameters: {
          max_pool_size: baseConfig.storage?.parameters?.max_pool_size ?? DEFAULT_MAX_POOL_SIZE
        }
      },
      client_keystore: keyStore,
      api_tokens: baseConfig.api?.tokens ?? [],
      port: baseConfig.port ?? 8080,
      sync_rules,
      jwt_audiences,

      token_max_expiration: '1d', // 1 day
      metadata: baseConfig.metadata ?? {},
      migrations: baseConfig.migrations,
      telemetry: {
        prometheus_port: baseConfig.telemetry?.prometheus_port,
        disable_telemetry_sharing: baseConfig.telemetry?.disable_telemetry_sharing ?? false,
        internal_service_endpoint:
          baseConfig.telemetry?.internal_service_endpoint ?? 'https://pulse.journeyapps.com/v1/metrics'
      },
      healthcheck: {
        /**
         * Default to legacy mode if no probes config is provided.
         * If users provide a config, all options require explicit opt-in.
         */
        probes: baseConfig.healthcheck?.probes
          ? {
              use_filesystem: baseConfig.healthcheck.probes.use_filesystem ?? false,
              use_http: baseConfig.healthcheck.probes.use_http ?? false,
              use_legacy: baseConfig.healthcheck.probes.use_legacy ?? false
            }
          : {
              use_filesystem: false,
              use_http: false,
              use_legacy: true
            }
      },
      api_parameters: {
        max_buckets_per_connection:
          baseConfig.api?.parameters?.max_buckets_per_connection ?? DEFAULT_MAX_BUCKETS_PER_CONNECTION,

        max_parameter_query_results:
          baseConfig.api?.parameters?.max_parameter_query_results ?? DEFAULT_MAX_PARAMETER_QUERY_RESULTS,
        max_concurrent_connections:
          baseConfig.api?.parameters?.max_concurrent_connections ?? DEFAULT_MAX_CONCURRENT_CONNECTIONS,
        max_data_fetch_concurrency:
          baseConfig.api?.parameters?.max_data_fetch_concurrency ?? DEFAULT_MAX_DATA_FETCH_CONCURRENCY
      },
      // TODO maybe move this out of the connection or something
      slot_name_prefix: baseConfig.replication?.connections?.[0]?.slot_name_prefix ?? 'powersync_',
      parameters: baseConfig.parameters ?? {}
    };

    return config;
  }

  /**
   * Collects the base PowerSyncConfig from various registered collectors.
   * @throws if no collector could return a configuration.
   */
  protected async collectBaseConfig(runner_config: RunnerConfig): Promise<configFile.PowerSyncConfig> {
    for (const collector of this.options.configCollectors) {
      try {
        const baseConfig = await collector.collect(runner_config);
        if (baseConfig) {
          return baseConfig;
        }
        logger.debug(
          `Could not collect PowerSync config with ${collector.name} method. Moving on to next method if available.`
        );
      } catch (ex) {
        // An error in a collector is a hard stop
        throw new Error(`Could not collect config using ${collector.name} method. Caught exception: ${ex}`);
      }
    }
    throw new Error('PowerSyncConfig could not be collected using any of the registered config collectors.');
  }

  protected async collectSyncRules(
    baseConfig: configFile.PowerSyncConfig,
    runnerConfig: RunnerConfig
  ): Promise<SyncRulesConfig> {
    for (const collector of this.options.syncRulesCollectors) {
      try {
        const config = await collector.collect(baseConfig, runnerConfig);
        if (config) {
          return config;
        }
        logger.debug(
          `Could not collect sync rules with ${collector.name} method. Moving on to next method if available.`
        );
      } catch (ex) {
        // An error in a collector is a hard stop
        throw new Error(`Could not collect sync rules using ${collector.name} method. Caught exception: ${ex}`);
      }
    }
    return {
      present: false,
      exit_on_error: true
    };
  }
}
