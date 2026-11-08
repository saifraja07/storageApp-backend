// Mimics a Mongoose Query: chainable (.lean/.select/.sort/…) and awaitable.
export function query(result) {
  const q = {
    lean: () => q,
    select: () => q,
    sort: () => q,
    populate: () => q,
    session: () => q,
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    catch: (reject) => Promise.resolve(result).catch(reject),
  };
  return q;
}
