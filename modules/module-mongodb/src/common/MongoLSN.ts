import { mongo } from '@powersync/lib-service-mongodb';
import { storage } from '@powersync/service-core';

export type MongoLSNSpecification = {
  timestamp: mongo.Timestamp;
  /**
   * The ResumeToken type here is an alias for `unknown`.
   * The docs mention the contents should be of the form:
   * ```typescript
   * {
   *   "_data" : <BinData|string>
   * }
   * ```
   * We use BSON serialization to store the resume token.
   */
  resume_token?: mongo.ResumeToken;
};

export const ZERO_LSN = '0000000000000000';

const DELIMINATOR = '|';

/**
 * Represent a Logical Sequence Number (LSN) for MongoDB replication sources.
 * This stores a combination of the cluster timestamp and optional Change Stream resume token.
 */
export class MongoLSN {
  static fromSerialized(comparable: string): MongoLSN {
    return new MongoLSN(MongoLSN.deserialize(comparable));
  }

  private static deserialize(comparable: string): MongoLSNSpecification {
    const [timestampString, resumeString] = comparable.split(DELIMINATOR);

    const a = parseInt(timestampString.substring(0, 8), 16);
    const b = parseInt(timestampString.substring(8, 16), 16);

    return {
      timestamp: mongo.Timestamp.fromBits(b, a),
      resume_token: resumeString ? storage.deserializeBson(Buffer.from(resumeString, 'base64')).resumeToken : null
    };
  }

  static fromResumeToken(resumeToken: mongo.ResumeToken): MongoLSN {
    const timestamp = parseResumeTokenTimestamp(resumeToken);
    return new MongoLSN({
      timestamp,
      resume_token: resumeToken
    });
  }

  static ZERO = MongoLSN.fromSerialized(ZERO_LSN);

  constructor(protected options: MongoLSNSpecification) {}

  get timestamp() {
    return this.options.timestamp;
  }

  get resumeToken() {
    return this.options.resume_token;
  }

  get comparable() {
    const { timestamp, resumeToken } = this;

    const a = timestamp.high.toString(16).padStart(8, '0');
    const b = timestamp.low.toString(16).padStart(8, '0');

    const segments = [`${a}${b}`];

    if (resumeToken) {
      segments.push(storage.serializeBson({ resumeToken }).toString('base64'));
    }

    return segments.join(DELIMINATOR);
  }

  toString() {
    return this.comparable;
  }
}

/**
 * Given a resumeToken in the form {_data: 'hex data'}, this parses the cluster timestamp.
 * All other data in the token is ignored.
 *
 * @param resumeToken
 * @returns a parsed timestamp
 */
export function parseResumeTokenTimestamp(resumeToken: mongo.ResumeToken): mongo.Timestamp {
  const hex = (resumeToken as any)._data as string;
  const buffer = Buffer.from(hex, 'hex');
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint8(0) != 130) {
    throw new Error(`Invalid resume token: ${hex}`);
  }
  const t = view.getUint32(1);
  const i = view.getUint32(5);

  return mongo.Timestamp.fromBits(i, t);
}
