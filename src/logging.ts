export const isDebugEnabled = (): boolean => {
  return process.env.GIT_SCRIBE_DEBUG === "1" || process.env.GIT_SCRIBE_DEBUG_AI === "1";
};

export const debugLog = (...args: string[]): void => {
  if (isDebugEnabled()) {
    console.error(...args);
  }
};
