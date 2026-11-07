export function localPort(value = process.env.KEXU_LOCAL_PORT) {
  if (value === undefined || value === '') return 5173;
  if (typeof value !== 'string' || !/^\d{4,5}$/.test(value)) throw new Error('本地端口需要为1024至65535的整数。');
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('本地端口需要为1024至65535的整数。');
  return port;
}
