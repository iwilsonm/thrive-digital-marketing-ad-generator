import { query } from "./_generated/server";

export const getCapabilities = query({
  args: {},
  handler: async () => {
    return {
      app: "thrive-digital-marketing-ad-generator",
      version: 1,
      capabilities: {
        adSetAtomicCombine: true,
        batchCronWorker: true,
      },
      checked_at: new Date().toISOString(),
    };
  },
});
