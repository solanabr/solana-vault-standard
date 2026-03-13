const originalWarn = console.warn.bind(console);

console.warn = (...args) => {
  const [firstArg] = args;

  if (
    typeof firstArg === "string" &&
    firstArg.startsWith("bigint: Failed to load bindings, pure JS will be used")
  ) {
    return;
  }

  originalWarn(...args);
};
