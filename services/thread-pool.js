/**
 * @file How many blocking calls this process can have in flight — set before
 * anything makes one.
 *
 * Node resolves host names with `getaddrinfo`, which runs on the libuv thread
 * pool, and that pool holds FOUR threads by default. A torrent announces to
 * every tracker in its file at once — ten or thirteen of them — so four names
 * are resolved and the rest queue; a tracker that no longer exists holds its
 * thread for the resolver's full ten-second timeout, and every announce behind
 * it blows its own fifteen-second deadline.
 *
 * Measured inside the addon container on 2026-08-18, resolving the ten trackers
 * of one film: as a burst on the default pool, two names answered in 30-40 ms
 * and the other seven took **7.58 s**; with a larger pool every live name
 * answered in **27-42 ms**. The film itself had 517 seeders on a tracker that
 * answers in 50 ms, and spent eleven minutes with zero peers, because every
 * announce — UDP and HTTP alike — timed out waiting for a name.
 *
 * Sized to hold several torrents' announce lists at once, since the same pool
 * also serves this process's file reads. Idle threads cost memory and nothing
 * else, and a deployment that states its own size is left alone.
 *
 * Imported FIRST by the entry point, because a module's imports are evaluated
 * before its body: written as a statement in `cli.js` this would run after
 * every other import had already had its chance to create the pool.
 */

if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = "64";
}
