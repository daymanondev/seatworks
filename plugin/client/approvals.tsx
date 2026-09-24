import type { PluginTheme, RpcInput } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, type SettingsInputHandle, SettingsRow } from "@getpaseo/plugin/client/ui";
import { useRef, useState } from "react";
import { Text } from "react-native";
import { landDecideRpc } from "../shared/rpc.ts";
import type { FlowLane, LandDecided } from "../shared/views.ts";

type Decide = (input: RpcInput<typeof landDecideRpc>) => Promise<LandDecided>;

const waited = (minutes: number) => (minutes < 1 ? "since just now" : `${minutes} min`);

/** Something held for the Human: their word comes from here and nowhere else, since no seat may give it for them. */
function Held({ project, lane, decide, label, hint, approved, sentBack, theme }: { project: string; lane: string; decide: Decide; label: string; hint: string; approved: string; sentBack: string; theme: PluginTheme }) {
  const field = useRef<SettingsInputHandle>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<LandDecided | null>(null);
  const send = (approve: boolean) => {
    setBusy(true);
    void decide({ project, lane, approve, note })
      .then((answer) => {
        setSaid(answer);
        if ("decided" in answer) field.current?.replaceText("");
      })
      .catch((error: unknown) => setSaid({ error: error instanceof Error ? error.message : String(error) }))
      .finally(() => setBusy(false));
  };
  return (
    <SettingsCard>
      <SettingsRow label={label} hint={hint} />
      <SettingsInput ref={field} label="Note for the Lead" hint="Say what to change when you send it back; optional when you approve." placeholder="What should change" onChangeText={setNote} disabled={busy} />
      <SettingsAction label="Approve" hint={approved} actionLabel="Approve" onPress={() => send(true)} disabled={busy} />
      <SettingsAction label="Send back" hint={sentBack} actionLabel="Send back" onPress={() => send(false)} disabled={busy} />
      {said ? <Text style={{ color: "error" in said ? theme.colors.statusWarning : theme.colors.foregroundMuted, fontSize: 12 }}>{"error" in said ? said.error : said.decided}</Text> : null}
    </SettingsCard>
  );
}

export function ApprovalsCards({ project, lanes, theme }: { project: string; lanes: FlowLane[]; theme: PluginTheme }) {
  const land = useRpc(landDecideRpc);
  return (
    <>
      {lanes.map((lane) =>
        lane.landApproval && !lane.landApproval.approved ? (
          <Held
            key={`${lane.id}:land`}
            project={project}
            lane={lane.id}
            decide={land}
            theme={theme}
            label={`${lane.id} ${lane.title} waits for you to land it on ${lane.base ?? "its base"}`}
            hint={`${lane.landApproval.signals.join(" ") || "This project approves every landing."} ${lane.landApproval.evidence.join(" ")} Waiting ${waited(lane.landApproval.minutes)}; the branch is ${lane.branch}.`}
            approved="It lands now, as the project lands lanes; if something stops it, it lands when the Supervisor closes the lane again."
            sentBack="Nothing lands; the lane stays open and its Lead gets your note."
          />
        ) : null,
      )}
    </>
  );
}
