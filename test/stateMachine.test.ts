import { describe, expect, it } from 'vitest';
import { BridgeStateMachine, StateTransitionError } from '../src/stateMachine';

describe('bridge state machine', () => {
  it('starts in reconciling and reaches idle after reconciliation', () => {
    const machine = new BridgeStateMachine();
    expect(machine.state.state).toBe('reconciling');
    expect(machine.transition({ type: 'PREREQUISITES_OK' }).state).toBe('idle');
  });

  it('supports the controlled mount and unmount lifecycle', () => {
    const machine = new BridgeStateMachine();
    machine.transition({ type: 'PREREQUISITES_OK' });
    machine.transition({ type: 'MOUNT_REQUESTED' });
    machine.transition({ type: 'PREREQUISITES_OK' });
    machine.transition({ type: 'MOUNT_READY' });
    machine.transition({ type: 'UNMOUNT_REQUESTED' });
    expect(machine.transition({ type: 'UNMOUNTED' }).state).toBe('idle');
  });

  it('rejects illegal transitions', () => {
    const machine = new BridgeStateMachine();
    expect(() => machine.transition({ type: 'MOUNT_READY' })).toThrow(StateTransitionError);
  });

  it('allows only reconciliation to recover from error', () => {
    const machine = new BridgeStateMachine();
    machine.transition({ type: 'FAILED', message: 'test failure' });
    expect(machine.state).toEqual({ state: 'error', errorMessage: 'test failure' });
    expect(() => machine.transition({ type: 'PREREQUISITES_OK' })).toThrow(StateTransitionError);
    expect(machine.transition({ type: 'RECONCILE' }).state).toBe('reconciling');
  });
});
