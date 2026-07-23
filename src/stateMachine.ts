import type { BridgeEvent, BridgeRuntimeState, BridgeState } from './types';

export class StateTransitionError extends Error {
  constructor(from: BridgeState, event: BridgeEvent['type']) {
    super(`不允许从状态 ${from} 处理事件 ${event}。`);
    this.name = 'StateTransitionError';
  }
}

const transitions: Record<BridgeState, Partial<Record<BridgeEvent['type'], BridgeState>>> = {
  reconciling: { RECONCILE: 'reconciling', PREREQUISITES_OK: 'idle', FAILED: 'error' },
  idle: { RECONCILE: 'reconciling', MOUNT_REQUESTED: 'checking', FAILED: 'error' },
  checking: { PREREQUISITES_OK: 'mounting', FAILED: 'error', RECONCILE: 'reconciling' },
  mounting: { MOUNT_READY: 'mounted', FAILED: 'error' },
  mounted: { UNMOUNT_REQUESTED: 'unmounting', FAILED: 'error' },
  unmounting: { UNMOUNTED: 'idle', FAILED: 'error' },
  error: { RECONCILE: 'reconciling' },
};

/**
 * 受控的插件状态机；状态转换集中管理，UI 不可直接写状态。
 * Controlled plugin state machine; transitions are centralized and the UI cannot write state directly.
 */
export class BridgeStateMachine {
  private runtime: BridgeRuntimeState = { state: 'reconciling' };

  get state(): BridgeRuntimeState {
    return { ...this.runtime };
  }

  transition(event: BridgeEvent): BridgeRuntimeState {
    const nextState = transitions[this.runtime.state][event.type];
    if (!nextState) {
      throw new StateTransitionError(this.runtime.state, event.type);
    }

    this.runtime = {
      state: nextState,
      ...(event.type === 'FAILED' ? { errorMessage: event.message } : {}),
    };
    return this.state;
  }
}
