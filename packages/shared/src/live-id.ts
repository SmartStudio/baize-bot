import { z } from "zod";

// 叶子模块，只引 zod：tool-view.ts 要用它，live.ts 又引 domain.ts，domain.ts 引 tool-view.ts，放一起会成环。
export const LiveId = z.string().uuid().brand<"LiveId">();
export type LiveId = z.infer<typeof LiveId>;
