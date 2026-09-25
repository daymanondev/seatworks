import { errorText } from "../core/errors.ts";
import { mask } from "../core/mask.ts";
import type { Judge, Judgement, Question } from "../core/ports.ts";

/** Where and how a sensor is asked, as its catalog file says; `body` holds what goes with every request, such as data rules. */
type Decisions = { url: string; model: string; body?: Record<string, unknown>; timeoutSeconds: number; retries: number };

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** Between retries. It holds the process open: a script left with nothing else to wait on exited mid-retry. */
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A body that stalls is as late as a response that never comes, so the one signal cuts both. */
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", stop);
        reject(error);
      },
    );
  });
}

/** Every question answered as a probability, or none: an answer with a question missing is not what was asked. */
function readJudgement(body: unknown, questions: Record<string, Question>): Judgement {
  const held = (body ?? {}) as { answers?: Record<string, { noul?: unknown }>; model?: unknown; usage?: { input_tokens?: unknown } };
  const answers: Record<string, number> = {};
  for (const name of Object.keys(questions)) {
    const answer = held.answers?.[name];
    if (!answer) throw new Error(`the answer to ${name} is missing`);
    const { noul } = answer;
    if (typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) throw new Error(`the answer to ${name} is not a probability`);
    answers[name] = noul;
  }
  if (typeof held.model !== "string") throw new Error("the response names no model");
  const tokens = held.usage?.input_tokens;
  return { answers, model: held.model, ...(typeof tokens === "number" ? { tokens } : {}) };
}

/** One request, tried again only where trying again can help: no reply, a 429 or a server error. */
async function decide(spec: Decisions, key: string, body: string, fetcher: Fetch): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const signal = AbortSignal.timeout(spec.timeoutSeconds * 1000);
    const late = `no answer within ${spec.timeoutSeconds} s`;
    let response: Awaited<ReturnType<Fetch>>;
    try {
      response = await bounded(fetcher(spec.url, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body, signal }), signal);
    } catch (error) {
      if (attempt < spec.retries) {
        await pause(500 * 2 ** attempt);
        continue;
      }
      throw new Error(signal.aborted ? late : `unreachable: ${errorText(error)}`);
    }
    if (response.ok) {
      return bounded(response.json(), signal).catch((error: unknown) => {
        throw new Error(signal.aborted ? late : `the answer is not JSON: ${errorText(error)}`);
      });
    }
    const after = Number(response.headers.get("retry-after"));
    const said = await bounded(response.text(), signal).catch(() => "");
    if ((response.status !== 429 && response.status < 500) || attempt >= spec.retries) throw new Error(`${response.status}: ${mask(said.replace(/\s+/g, " ")).slice(0, 200)}`);
    await pause(Number.isFinite(after) && after > 0 ? Math.min(after, 10) * 1000 : 500 * 2 ** attempt);
  }
}

/** A sensor answering over HTTP. What goes with every request goes first, so it never replaces what is asked. */
export function decisionsJudge(spec: Decisions, key: string, fetcher: Fetch = fetch as unknown as Fetch): Judge {
  return {
    async ask(state, questions) {
      const body = JSON.stringify({ ...spec.body, model: spec.model, state, questions });
      return readJudgement(await decide(spec, key, body, fetcher), questions);
    },
  };
}
