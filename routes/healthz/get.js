export async function handleHealthzGet(_req, reply) {
  return reply.send({ ok: true });
}
