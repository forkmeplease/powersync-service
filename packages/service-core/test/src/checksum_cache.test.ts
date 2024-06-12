import { describe, expect, it } from 'vitest';
import {
  ChecksumCache,
  ChecksumCacheInterface,
  FetchChecksums,
  FetchPartialBucketChecksum
} from '../../src/storage/ChecksumCache.js';
import { ChecksumCache as ChecksumCacheTwo } from '../../src/storage/ChecksumCacheTwo.js';
import { BucketChecksum, OpId } from '@/util/protocol-types.js';
import * as crypto from 'node:crypto';
import { addBucketChecksums } from '@/util/util-index.js';

type CachsumCacheFactory = (fetch: FetchChecksums) => ChecksumCacheInterface;

describe('checksum cache 1', function () {
  defineChecksumCacheTests((f) => new ChecksumCache({ fetchChecksums: f }));
});

describe('checksum cache 2', function () {
  defineChecksumCacheTests((f) => new ChecksumCacheTwo({ fetchChecksums: f }));
});

/**
 * Create a deterministic BucketChecksum based on the bucket name and checkpoint for testing purposes.
 */
function testHash(bucket: string, checkpoint: OpId) {
  const key = `${checkpoint}/${bucket}`;
  const hash = crypto.createHash('sha256').update(key).digest().readInt32LE(0);
  return hash;
}

function testPartialHash(request: FetchPartialBucketChecksum): BucketChecksum {
  if (request.start) {
    const a = testHash(request.bucket, request.start);
    const b = testHash(request.bucket, request.end);
    return addBucketChecksums(
      {
        bucket: request.bucket,
        checksum: b,
        count: Number(request.end)
      },
      {
        // Subtract a
        bucket: request.bucket,
        checksum: -a,
        count: -Number(request.start)
      }
    );
  } else {
    return {
      bucket: request.bucket,
      checksum: testHash(request.bucket, request.end),
      count: Number(request.end)
    };
  }
}

const TEST_123 = {
  bucket: 'test',
  count: 123,
  checksum: 1104081737
};

const TEST_1234 = {
  bucket: 'test',
  count: 1234,
  checksum: -1593864957
};

const TEST2_123 = {
  bucket: 'test2',
  count: 123,
  checksum: 1741377449
};

const TEST3_123 = {
  bucket: 'test3',
  count: 123,
  checksum: -2085080402
};

function fetchTestChecksums(batch: FetchPartialBucketChecksum[]) {
  return new Map(
    batch.map((v) => {
      return [v.bucket, testPartialHash(v)];
    })
  );
}

function defineChecksumCacheTests(factory: CachsumCacheFactory) {
  it('should handle a sequential lookups (a)', async function () {
    let lookups: FetchPartialBucketChecksum[][] = [];
    const cache = factory(async (batch) => {
      lookups.push(batch);
      return fetchTestChecksums(batch);
    });

    expect(await cache.getChecksums('123', ['test'])).toEqual([TEST_123]);

    expect(await cache.getChecksums('1234', ['test'])).toEqual([TEST_1234]);

    expect(await cache.getChecksums('123', ['test2'])).toEqual([TEST2_123]);

    expect(lookups).toEqual([
      [{ bucket: 'test', end: '123' }],
      // This should use the previous lookup
      [{ bucket: 'test', start: '123', end: '1234' }],
      [{ bucket: 'test2', end: '123' }]
    ]);
  });

  it('should handle a sequential lookups (b)', async function () {
    // Reverse order of the above
    let lookups: FetchPartialBucketChecksum[][] = [];
    const cache = factory(async (batch) => {
      lookups.push(batch);
      return fetchTestChecksums(batch);
    });

    expect(await cache.getChecksums('123', ['test2'])).toEqual([TEST2_123]);

    expect(await cache.getChecksums('1234', ['test'])).toEqual([TEST_1234]);

    expect(await cache.getChecksums('123', ['test'])).toEqual([TEST_123]);

    expect(lookups).toEqual([
      // With this order, there is no option for a partial lookup
      [{ bucket: 'test2', end: '123' }],
      [{ bucket: 'test', end: '1234' }],
      [{ bucket: 'test', end: '123' }]
    ]);
  });

  it('should handle a concurrent lookups (a)', async function () {
    let lookups: FetchPartialBucketChecksum[][] = [];
    const cache = factory(async (batch) => {
      lookups.push(batch);
      return fetchTestChecksums(batch);
    });

    const p1 = cache.getChecksums('123', ['test']);
    const p2 = cache.getChecksums('1234', ['test']);
    const p3 = cache.getChecksums('123', ['test2']);

    expect(await p1).toEqual([TEST_123]);
    expect(await p2).toEqual([TEST_1234]);
    expect(await p3).toEqual([TEST2_123]);

    // Concurrent requests, so we can't do a partial lookup for 123 -> 1234
    expect(lookups).toEqual([
      [{ bucket: 'test', end: '123' }],
      [{ bucket: 'test', end: '1234' }],
      [{ bucket: 'test2', end: '123' }]
    ]);
  });

  it('should handle a concurrent lookups (b)', async function () {
    let lookups: FetchPartialBucketChecksum[][] = [];
    const cache = factory(async (batch) => {
      lookups.push(batch);
      return fetchTestChecksums(batch);
    });

    const p1 = cache.getChecksums('123', ['test']);
    const p2 = cache.getChecksums('123', ['test']);

    expect(await p1).toEqual([TEST_123]);

    expect(await p2).toEqual([TEST_123]);

    // The lookup should be deduplicated, even though it's in progress
    expect(lookups).toEqual([[{ bucket: 'test', end: '123' }]]);
  });

  it('should handle serial + concurrent lookups', async function () {
    let lookups: FetchPartialBucketChecksum[][] = [];
    const cache = factory(async (batch) => {
      lookups.push(batch);
      return fetchTestChecksums(batch);
    });

    expect(await cache.getChecksums('123', ['test'])).toEqual([TEST_123]);

    const p2 = cache.getChecksums('1234', ['test']);
    const p3 = cache.getChecksums('1234', ['test']);

    expect(await p2).toEqual([TEST_1234]);
    expect(await p3).toEqual([TEST_1234]);

    expect(lookups).toEqual([
      [{ bucket: 'test', end: '123' }],
      // This lookup is deduplicated
      [{ bucket: 'test', start: '123', end: '1234' }]
    ]);
  });

  it('should handle multiple buckets', async function () {
    let lookups: FetchPartialBucketChecksum[][] = [];
    const cache = factory(async (batch) => {
      lookups.push(batch);
      return fetchTestChecksums(batch);
    });

    expect(await cache.getChecksums('123', ['test', 'test2'])).toEqual([TEST_123, TEST2_123]);

    expect(lookups).toEqual([
      [
        // Both lookups in the same request
        { bucket: 'test', end: '123' },
        { bucket: 'test2', end: '123' }
      ]
    ]);
  });

  it('should handle multiple buckets with partial caching (a)', async function () {
    let lookups: FetchPartialBucketChecksum[][] = [];
    const cache = factory(async (batch) => {
      lookups.push(batch);
      return fetchTestChecksums(batch);
    });

    expect(await cache.getChecksums('123', ['test'])).toEqual([TEST_123]);
    expect(await cache.getChecksums('123', ['test', 'test2'])).toEqual([TEST_123, TEST2_123]);

    expect(lookups).toEqual([
      // Request 1
      [{ bucket: 'test', end: '123' }],
      // Request 2
      [{ bucket: 'test2', end: '123' }]
    ]);
  });

  it('should handle multiple buckets with partial caching (b)', async function () {
    let lookups: FetchPartialBucketChecksum[][] = [];
    const cache = factory(async (batch) => {
      lookups.push(batch);
      return fetchTestChecksums(batch);
    });

    const a = cache.getChecksums('123', ['test', 'test2']);
    const b = cache.getChecksums('123', ['test2', 'test3']);

    expect(await a).toEqual([TEST_123, TEST2_123]);
    expect(await b).toEqual([TEST2_123, TEST3_123]);

    expect(lookups).toEqual([
      // Request a
      [
        { bucket: 'test', end: '123' },
        { bucket: 'test2', end: '123' }
      ],
      // Request b (re-uses the checksum for test2 from request a)
      [{ bucket: 'test3', end: '123' }]
    ]);
  });
}
