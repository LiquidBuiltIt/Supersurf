export const meta = {
  description: 'Golden fixture: logs a line and returns a constant',
  params: {},
};

export default async function ({ log }) {
  log('golden-ran');
  return { value: 'golden-result' };
}
