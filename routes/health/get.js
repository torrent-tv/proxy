export async function handleHealthGet(_req, reply) {
  return reply.send({ ok: true });
}
