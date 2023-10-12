const CLEAN = 0;
const MAYBE_DIRTY = 1;
const DIRTY = 2;
const DESTROYED = 3;

const UNINITIALIZED = Symbol();

let current_consumer: null | Computed<any> | Effect<any> = null;
let current_effect: null | Effect<any> = null;
let current_sources: null | Set<Signal<any>> = null;
let current_untracking = false;
// To prevent leaking when accumulating consumers during computed.get(),
// we can track unowned computed signals and skip their consumers
// accordingly in the cases where there's no current parent effect
// when reading the computed via computed.get().
let current_skip_consumer = false;

type SignalStatus =
  | typeof DIRTY
  | typeof MAYBE_DIRTY
  | typeof CLEAN
  | typeof DESTROYED;

export type StateOptions<T> = {
  equals?: (a: T, b: T) => boolean;
};

export type ComputedOptions<T> = {
  equals?: (a: T, b: T) => boolean;
};

function markSignalConsumers<T>(
  signal: Signal<T>,
  toStatus: SignalStatus,
  forceNotify: boolean
): void {
  const consumers = signal.consumers;
  if (consumers !== null) {
    for (const consumer of consumers) {
      const status = consumer.status;
      const isEffect = consumer instanceof Effect;
      if (
        status === DIRTY ||
        (isEffect && !forceNotify && consumer.pending_notify)
      ) {
        continue;
      }
      consumer.status = toStatus;
      if (status === CLEAN) {
        if (isEffect) {
          notifyEffect(consumer);
        } else {
          markSignalConsumers(consumer, MAYBE_DIRTY, forceNotify);
        }
      }
    }
  }
}

function updateEffectSignal<T>(signal: Effect<T>): void {
  const previous_effect = current_effect;
  current_effect = signal;
  try {
    destroyEffectChildren(signal);
    signal.value = executeSignalCallback(signal);
  } finally {
    current_effect = previous_effect;
  }
}

function isSignalDirty<T>(signal: Computed<T> | Effect<T>): boolean {
  const status = signal.status;
  if (status === DIRTY) {
    return true;
  }
  if (status === MAYBE_DIRTY) {
    const sources = signal.sources;
    if (sources !== null) {
      for (const source of sources) {
        const sourceStatus = source.status;

        if (source instanceof State) {
          if (sourceStatus === DIRTY) {
            source.status = CLEAN;
            return true;
          }
          continue;
        }
        if (
          sourceStatus === MAYBE_DIRTY &&
          !isSignalDirty(source as Computed<T>)
        ) {
          source.status = CLEAN;
          continue;
        }
        if (source.status === DIRTY) {
          updateComputedSignal(source as Computed<T>, true);
          // Might have been mutated from above get.
          if (signal.status === DIRTY) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

function removeConsumer<T>(
  signal: Computed<T> | Effect<T>,
  removeUnowned: boolean
): void {
  const sources = signal.sources;
  if (sources !== null) {
    for (const source of sources) {
      const consumers = source.consumers;
      let consumers_size = 0;
      if (consumers !== null) {
        consumers_size = consumers.size - 1;
        consumers.delete(signal);
      }
      if (
        removeUnowned &&
        consumers_size === 0 &&
        source instanceof Computed &&
        source.unowned
      ) {
        const oncleanup = source.oncleanup;
        if (source.value !== UNINITIALIZED && typeof oncleanup === "function") {
          oncleanup.call(source);
        }
        removeConsumer(source, true);
      }
    }
  }
}

function destroySignal<T>(signal: Signal<T>): void {
  const value = signal.value;
  signal.status = DESTROYED;
  signal.value = UNINITIALIZED as T;
  signal.equals = Object.is;
  signal.consumers = null;
  if (signal instanceof Effect) {
    removeConsumer(signal, true);
    signal.sources = null;
    destroyEffectChildren(signal);
    const oncleanup = signal.oncleanup;
    if (value !== UNINITIALIZED && typeof oncleanup === "function") {
      oncleanup.call(signal);
    }
    signal.children = null;
    signal.notify = null;
  } else if (signal instanceof Computed) {
    removeConsumer(signal, true);
    signal.sources = null;
    const oncleanup = signal.oncleanup;
    if (typeof oncleanup === "function") {
      oncleanup.call(signal);
    }
  }
}

function destroyEffectChildren<V>(signal: Effect<V>): void {
  const children = signal.children;
  signal.children = null;
  if (children !== null) {
    for (let i = 0; i < children.length; i++) {
      destroySignal(children[i]);
    }
  }
}

function updateComputedSignal<T>(
  signal: Computed<T>,
  forceNotify: boolean
): void {
  signal.status =
    current_skip_consumer || (current_effect === null && signal.unowned)
      ? DIRTY
      : CLEAN;
  const value = executeSignalCallback(signal);
  const equals = signal.equals!;
  if (!equals.call(signal, signal.value, value)) {
    signal.value = value;
    markSignalConsumers(signal, DIRTY, forceNotify);
  }
}

function executeSignalCallback<T>(signal: Computed<T> | Effect<T>): T {
  const previous_sources = current_sources;
  const previous_consumer = current_consumer;
  const previous_skip_consumer = current_skip_consumer;
  current_sources = null;
  current_consumer = signal;
  current_skip_consumer =
    current_effect === null && signal instanceof Computed && signal.unowned;

  try {
    const oncleanup = signal.oncleanup;
    if (signal.value !== UNINITIALIZED && typeof oncleanup === "function") {
      oncleanup.call(signal);
    }
    const value = signal.callback();
    let sources = signal.sources;

    if (current_sources !== null) {
      removeConsumer(signal, false);
      signal.sources = sources = current_sources as Set<Signal<any>>;

      if (!current_skip_consumer) {
        for (const source of sources) {
          if (source.consumers === null) {
            source.consumers = new Set([signal]);
          } else {
            source.consumers.add(signal);
          }
        }
      }
    } else if (sources !== null) {
      removeConsumer(signal, false);
      sources.clear();
    }

    return value;
  } finally {
    current_sources = previous_sources;
    current_consumer = previous_consumer;
    current_skip_consumer = previous_skip_consumer;
  }
}

function updateSignalSources<T>(signal: Signal<T>): void {
  if (signal.status === DESTROYED) {
    return;
  }
  // Register the source on the current consumer signal.
  if (current_consumer !== null && !current_untracking) {
    if (current_sources === null) {
      current_sources = new Set([signal]);
    } else if (!current_sources.has(signal)) {
      current_sources.add(signal);
    }
  }
}

function pushChild<T>(target: Effect<T>, child: Signal<T>): void {
  const children = target.children;
  if (children === null) {
    target.children = [child];
  } else {
    children.push(child);
  }
}

function notifyEffect<T>(signal: Effect<T>): void {
  const notify = signal.notify;
  if (notify !== null) {
    signal.pending_notify = true;
    if (signal.notify_id === Number.MAX_SAFE_INTEGER) {
      signal.notify_id = 0;
    } else {
      signal.notify_id++;
    }
    notify.call(signal, signal);
  }
}

class Signal<T> {
  consumers: null | Set<Computed<any> | Effect<any>>;
  equals: (a: T, b: T) => boolean;
  status: SignalStatus;
  value: T;

  constructor(value: T, options?: StateOptions<T>) {
    this.consumers = null;
    this.equals = options?.equals || Object.is;
    this.status = DIRTY;
    this.value = value;
  }

  get(): T {
    updateSignalSources(this);
    return this.value;
  }
}

export class State<T> extends Signal<T> {
  set(value: T): void {
    if (!current_untracking && current_consumer instanceof Computed) {
      throw new Error(
        "Writing to state signals during the computation phase (from within computed signals) is not permitted."
      );
    }
    if (!this.equals.call(this, this.value, value)) {
      this.value = value;
      if (
        !current_untracking &&
        current_effect !== null &&
        current_effect.consumers === null &&
        current_effect.status === CLEAN
      ) {
        current_effect.status = DIRTY;
        notifyEffect(current_effect);
      }
      markSignalConsumers(this, DIRTY, true);
    }
  }
}

export class Computed<T> extends Signal<T> {
  callback: () => T;
  sources: null | Set<Signal<any>>;
  oncleanup: null | (() => void);
  unowned: boolean;

  constructor(callback: () => T, options?: ComputedOptions<T>) {
    super(UNINITIALIZED as T, options);
    const unowned = current_effect === null;
    this.callback = callback;
    this.sources = null;
    this.oncleanup = null;
    this.unowned = unowned;
    if (!unowned) {
      pushChild(current_effect!, this);
    }
  }

  get(): T {
    updateSignalSources(this);
    if (isSignalDirty(this)) {
      updateComputedSignal(this, false);
    }
    return this.value;
  }
}

export class Effect<T> extends Signal<T> {
  callback: () => T;
  sources: null | Set<Signal<any>>;
  notify: null | ((signal: Effect<T>) => void);
  pending_notify: boolean;
  notify_id: number;
  oncleanup: null | (() => void);
  children: null | Signal<any>[];

  constructor(callback: () => T) {
    super(UNINITIALIZED as T);
    this.callback = callback;
    this.sources = null;
    this.notify = null;
    this.oncleanup = null;
    this.children = null;
    this.pending_notify = false;
    this.notify_id = 0;
    if (current_effect !== null) {
      pushChild(current_effect, this);
    }
  }

  start(notify: (signal: Effect<T>) => void): void {
    this.notify = notify;
  }

  stop(): void {
    if (this.notify !== null) {
      removeConsumer(this, true);
      destroyEffectChildren(this);
      const oncleanup = this.oncleanup;
      if (this.value !== UNINITIALIZED && typeof oncleanup === "function") {
        oncleanup.call(this);
      }
    }
    this.notify = null;
  }

  get(): T {
    if (current_consumer instanceof Computed) {
      throw new Error(
        "Reading effect signals during the computation phase (from within computed signals) is not permitted."
      );
    }
    if (isSignalDirty(this)) {
      const prev_notify_id = this.notify_id;
      this.status = CLEAN;
      updateEffectSignal(this);
      if (this.notify_id === prev_notify_id) {
        this.pending_notify = false;
      }
    }
    return this.value;
  }
}

function untrack<T>(fn: () => T): T {
  const previous_untracking = current_untracking;
  try {
    current_untracking = true;
    return fn();
  } finally {
    current_untracking = previous_untracking;
  }
}

export const unsafe = {
  untrack,
};
