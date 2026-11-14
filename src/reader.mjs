export function registerValue(register) {
  if (!Number.isInteger(register.scaler) || !Number.isFinite(register.value)) throw new Error('invalid register');
  return {id:register.logicalName,raw:register.value,value:register.value * 10 ** register.scaler,unit:register.unit};
}
export async function collect(client) { return [registerValue(await client('/register'))]; }
