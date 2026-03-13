const originalWarn = console.warn.bind(console);

console.warn = (...args) => {
  const message = args.map(String).join(" ");
  if (
    message.includes(
      "bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)",
    )
  ) {
    return;
  }

  originalWarn(...args);
};
