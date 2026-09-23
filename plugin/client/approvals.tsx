import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, type SettingsInputHandle, SettingsRow } from "@getpaseo/plugin/client/ui";
import { useRef, useState } from "react";
import { Text } from "react-native";
import { planDecideRpc } from "../shared/rpc.ts";
import type { FlowLane } from "./data.ts";

type Decided = { decided?: string; error?: string };

/** One plan held for the Human: their approval comes from here and nowhere else, since no seat may give it for them. */
function Held({ project, lane, theme }: { project: string; lane: FlowLane & { approval: NonNullable<FlowLane["approval"]> }; theme: PluginTheme }) {
  const decide = useRpc(planDecideRpc) as unknown as (input: { project: string; lane: string; approve: boolean; note: string }) => Promise<Decided>;
  const field = useRef<SettingsInputHandle>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Decided | null>(null);
  const { plan, minutes, signals } = lane.approval;
  const send = (approve: boolean) => {
    setBusy(true);
    void decide({ project, lane: lane.id, approve, note })
      .then((answer) => {
        setSaid(answer);
        if (answer.decided) field.current?.replaceText("");
      })
      .catch((error: unknown) => setSaid({ error: error instanceof Error ? error.message : String(error) }))
      .finally(() => setBusy(false));
  };
  return (
    <SettingsCard>
      <SettingsRow
        label={`Plan ${plan} of ${lane.id} ${lane.title} waits for you`}
        hint={`${signals.join(" ") || "This project approves every plan before it runs."} Waiting ${minutes < 1 ? "since just now" : `${minutes} min`}; open the lane above to read its tasks.`}
      />
      <SettingsInput ref={field} label="Note for the Lead" hint="Say what to change when you send it back; optional when you approve." placeholder="What should change" onChangeText={setNote} disabled={busy} />
      <SettingsAction label="Approve" hint="Its tasks start as what each waits for is accepted." actionLabel="Approve" onPress={() => send(true)} disabled={busy} />
      <SettingsAction label="Send back" hint="Its tasks are cut, and the Lead plans again with your note." actionLabel="Send back" onPress={() => send(false)} disabled={busy} />
      {said ? <Text style={{ color: said.error ? theme.colors.statusWarning : theme.colors.foregroundMuted, fontSize: 12 }}>{said.error ?? said.decided}</Text> : null}
    </SettingsCard>
  );
}

export function ApprovalsCards({ project, lanes, theme }: { project: string; lanes: FlowLane[]; theme: PluginTheme }) {
  const held = lanes.filter((lane): lane is FlowLane & { approval: NonNullable<FlowLane["approval"]> } => lane.approval?.by === "human");
  return (
    <>
      {held.map((lane) => (
        <Held key={`${lane.id}:${lane.approval.plan}`} project={project} lane={lane} theme={theme} />
      ))}
    </>
  );
}
