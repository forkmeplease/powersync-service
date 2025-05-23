import { AbortError } from 'ix/aborterror.js';
import { wrapWithAbort } from 'ix/asynciterable/operators/withabort.js';
import { LastValueSink } from './LastValueSink.js';

export interface DemultiplexerValue<T> {
  /**
   * The key used for demultiplexing, for example the user id.
   */
  key: string;
  /**
   * The stream value.
   */
  value: T;
}

export interface DemultiplexerSource<T> {
  /**
   * The async iterator providing a stream of values.
   */
  iterator: AsyncIterable<DemultiplexerValue<T>>;

  /**
   * Fetches the first value for a given key.
   *
   * This is used to get an initial value for each subscription.
   */
  getFirstValue(key: string): Promise<T>;
}

export type DemultiplexerSourceFactory<T> = (signal: AbortSignal) => DemultiplexerSource<T>;

/**
 * Takes a multiplexed stream (e.g. a changestream covering many individual users),
 * and allows subscribing to individual streams.
 *
 * The source subscription is lazy:
 * 1. We only start subscribing when there is a downstream subscriber.
 * 2. When all downstream subscriptions have ended, we end the source subscription.
 *
 * For each subscriber, if backpressure builds up, we only keep the _last_ value.
 */
export class Demultiplexer<T> {
  private subscribers: Map<string, Set<LastValueSink<T>>> | undefined = undefined;
  private abortController: AbortController | undefined = undefined;
  private currentSource: DemultiplexerSource<T> | undefined = undefined;

  constructor(private source: DemultiplexerSourceFactory<T>) {}

  private start(filter: string, sink: LastValueSink<T>) {
    const abortController = new AbortController();
    const listeners = new Map();
    listeners.set(filter, new Set([sink]));

    this.abortController = abortController;
    this.subscribers = listeners;

    const source = this.source(abortController.signal);
    this.currentSource = source;
    this.loop(source, abortController, listeners);
    return source;
  }

  private async loop(
    source: DemultiplexerSource<T>,
    abortController: AbortController,
    sinks: Map<string, Set<LastValueSink<T>>>
  ) {
    try {
      for await (let doc of source.iterator) {
        if (abortController.signal.aborted || sinks.size == 0) {
          throw new AbortError();
        }
        const key = doc.key;
        const keySinks = sinks.get(key);
        if (keySinks == null) {
          continue;
        }

        for (let sink of keySinks) {
          sink.write(doc.value);
        }
      }

      // End of stream
      for (let keySinks of sinks.values()) {
        for (let sink of keySinks) {
          sink.end();
        }
      }
    } catch (e) {
      // Just in case the error is not from the source
      abortController.abort();

      for (let keySinks of sinks.values()) {
        for (let sink of keySinks) {
          sink.error(e);
        }
      }
    } finally {
      // Clear state, so that a new subscription may be started
      if (this.subscribers === sinks) {
        this.subscribers = undefined;
        this.abortController = undefined;
        this.currentSource = undefined;
      }
    }
  }

  private removeSink(key: string, sink: LastValueSink<T>) {
    const existing = this.subscribers?.get(key);
    if (existing == null) {
      return;
    }
    existing.delete(sink);
    if (existing.size == 0) {
      this.subscribers!.delete(key);
    }

    if (this.subscribers?.size == 0) {
      // This is not immediate - there may be a delay until it is fully stopped,
      // depending on the underlying source.
      this.abortController?.abort();
      this.subscribers = undefined;
      this.abortController = undefined;
      this.currentSource = undefined;
    }
  }

  private addSink(key: string, sink: LastValueSink<T>) {
    if (this.currentSource == null) {
      return this.start(key, sink);
    } else {
      const existing = this.subscribers!.get(key);
      if (existing != null) {
        existing.add(sink);
      } else {
        this.subscribers!.set(key, new Set([sink]));
      }
      return this.currentSource;
    }
  }

  /**
   * Subscribe to a specific stream.
   *
   * @param key The key used for demultiplexing, e.g. user id.
   * @param signal
   */
  async *subscribe(key: string, signal: AbortSignal): AsyncIterable<T> {
    const sink = new LastValueSink<T>(undefined);
    // Important that we register the sink before calling getFirstValue().
    const source = this.addSink(key, sink);
    try {
      const firstValue = await source.getFirstValue(key);
      yield firstValue;
      yield* sink.withSignal(signal);
    } finally {
      this.removeSink(key, sink);
    }
  }

  get active() {
    return this.subscribers != null;
  }
}
