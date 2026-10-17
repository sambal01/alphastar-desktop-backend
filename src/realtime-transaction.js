"use strict";

// A one-shot get() does not keep the SDK's transaction cache populated. Keep
// a value listener at the transaction path until the commit/abort completes,
// so validation runs against a complete snapshot instead of an empty cache.
async function transactionWithLiveSnapshot(ref, update) {
  let listener;
  try {
    await new Promise((resolve, reject) => {
      listener = () => resolve();
      ref.on("value", listener, reject);
    });
    return await ref.transaction(update, undefined, false);
  } finally {
    if (listener) ref.off("value", listener);
  }
}

module.exports = { transactionWithLiveSnapshot };
