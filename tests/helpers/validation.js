/**
 * Runs a Mongoose document's validation (no database needed) and returns the
 * names of the invalid fields — an empty array means the document is valid.
 */
export async function errorFields(doc) {
  try {
    await doc.validate();
    return [];
  } catch (err) {
    return Object.keys(err.errors ?? {});
  }
}
