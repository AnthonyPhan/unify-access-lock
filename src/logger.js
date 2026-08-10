function write(level, message, fields = {}) {
  const record = {
    time: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  const output = JSON.stringify(record);
  (level === "error" ? console.error : console.log)(output);
}

export const logger = {
  info: (message, fields) => write("info", message, fields),
  warn: (message, fields) => write("warn", message, fields),
  error: (message, fields) => write("error", message, fields),
};
