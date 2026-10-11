import { POKER_PERSONAS, type PokerPersona } from "@baize/shared";
import { type ChatRequest, type ScriptedTurn } from "../src/upstream.js";

export const POKER_HINT = "A♠ K♦ 可以先加注到 40，观察牌友的回应。";

const usage = { input: 1_200, output: 30 };
const textTurn: ScriptedTurn = { textChunks: ["行动完成。"], usage };

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content) ?? "";
  return content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
        ? part.text
        : JSON.stringify(part),
    )
    .join("");
}

export function pokerTurn(request: ChatRequest) {
  const index = request.messages.findLastIndex((message) => message.role === "user");
  if (index < 0) return undefined;
  const prompt = contentText(request.messages[index]?.content);
  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => contentText(message.content));
  const persona = (Object.keys(POKER_PERSONAS) as PokerPersona[]).find((key) =>
    system.some((part) => part.includes(`你是${POKER_PERSONAS[key].name}，`)),
  );
  if (persona === undefined) return undefined;
  const tools = request.messages.slice(index + 1).filter((message) => message.role === "tool");
  return { prompt, persona, tools };
}

type Decision = { persona: PokerPersona; handId: string; seq: number; seat: string };
type ScriptAction = Decision & { action: string; callId: string };

export function pokerScript() {
  const actions: ScriptAction[] = [];
  let firstRejected: Decision | undefined;
  const script = (request: ChatRequest): ScriptedTurn => {
    const turn = pokerTurn(request);
    if (turn === undefined) throw new Error("系统提示里没有预置牌友人设");
    const { prompt, persona, tools } = turn;
    if (persona === "laobai") {
      if (!prompt.startsWith("散场复盘：")) return { ...textTurn, textChunks: [POKER_HINT] };
      if (tools.length > 0) return textTurn;
      const numbers = [...prompt.matchAll(/第 (\d+) 手：/g)].map((match) => Number(match[1]));
      return {
        ...textTurn,
        textChunks: [],
        toolCall: {
          id: "review",
          name: "poker_review",
          args: {
            hands: numbers.map((number) => ({
              number,
              title: `第 ${number} 手复盘`,
              text: "按位置和合法动作控制投入。",
            })),
          },
        },
      };
    }

    const result = tools.at(-1);
    if (result !== undefined && contentText(result.content).includes("出牌已确认。")) return textTurn;
    const hand = /本手：([^；]+)；决策点：(\d+)/.exec(prompt);
    const seat = /你的位置：(\d)，/.exec(prompt)?.[1];
    const legal = /^合法动作：(.*)$/m.exec(prompt)?.[1];
    if (hand?.[1] === undefined || hand[2] === undefined || seat === undefined || legal === undefined) {
      throw new Error("牌友请求缺少决策点");
    }
    const decision: Decision = { persona, handId: hand[1], seq: Number(hand[2]), seat };
    const retryingRejected =
      firstRejected !== undefined &&
      firstRejected.persona === decision.persona &&
      firstRejected.handId === decision.handId &&
      firstRejected.seq === decision.seq &&
      firstRejected.seat === decision.seat;
    let action = legal.includes("；过牌") ? "check" : "call";
    if (firstRejected === undefined && legal.startsWith("待跟注 0；")) {
      firstRejected = decision;
      action = "call";
    } else if (retryingRejected) {
      action = "check";
    }

    const callId = `act-${actions.length + 1}`;
    actions.push({ ...decision, action, callId });
    return {
      ...textTurn,
      textChunks: [],
      toolCall: {
        id: callId,
        name: "poker_act",
        args: { action, say: `${POKER_PERSONAS[persona].name}在${seat}号位出牌。` },
      },
    };
  };
  return { script, actions, rejected: () => firstRejected };
}
