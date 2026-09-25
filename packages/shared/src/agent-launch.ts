import { z } from "zod";
import { ComputerId } from "./domain.js";

export const AgentLaunch = z
  .object({
    url: z.string().min(1),
    computerId: ComputerId,
    token: z.string().min(1),
    dataDir: z.string().min(1),
  })
  .strict();
export type AgentLaunch = z.infer<typeof AgentLaunch>;
