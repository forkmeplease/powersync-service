import { ServiceError } from '@powersync/lib-services-framework';
import * as util from '../util/util-index.js';
import { BucketStorageFactory } from './BucketStorageFactory.js';

export interface ActiveStorage {
  storage: BucketStorageFactory;
  shutDown(): Promise<void>;

  /**
   *  Tear down / drop the storage permanently
   */
  tearDown(): Promise<boolean>;

  onFatalError?(callback: (error: ServiceError) => void): void;
}

export interface GetStorageOptions {
  // TODO: This should just be the storage config. Update once the slot name prefix coupling has been removed from the storage
  resolvedConfig: util.ResolvedPowerSyncConfig;
}

/**
 * Represents a provider that can create a storage instance for a specific storage type from configuration.
 */
export interface BucketStorageProvider {
  /**
   *  The storage type that this provider provides.
   *  The type should match the `type` field in the config.
   */
  type: string;

  getStorage(options: GetStorageOptions): Promise<ActiveStorage>;
}
