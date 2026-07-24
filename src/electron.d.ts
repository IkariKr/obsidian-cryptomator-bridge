declare module 'electron' {
  export const powerMonitor: {
    getSystemIdleTime(): number;
    on(event: 'lock-screen', listener: () => void): void;
    removeListener(event: 'lock-screen', listener: () => void): void;
  };
  export const remote: {
    require(moduleName: string): unknown;
  } | undefined;
}
