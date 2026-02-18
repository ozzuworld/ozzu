import { useState, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  Pressable,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { StatusBadge } from "../components/StatusBadge";
import { TVPressable } from "../components/TVPressable";
import { usePhoneLayout } from "../lib/usePhoneLayout";
import {
  fetchAudioPreferences,
  setAudioPreferences,
  type AudioPreferences,
  type AudioDevice,
} from "../lib/bridge-api";

const TOP_BAR_HEIGHT = 48;
const CYAN = "#06B6D4";
const CARD_BG = "#111111";
const BORDER = "#222";
const GREEN = "#22C55E";
const GRAY = "#525252";

function SectionHeader({ title }: { title: string }) {
  return (
    <Text
      style={{
        color: CYAN,
        fontSize: 11,
        fontFamily: "monospace",
        fontWeight: "bold",
        letterSpacing: 2,
        marginTop: 20,
        marginBottom: 8,
      }}
    >
      {title}
    </Text>
  );
}

function RadioOption({
  label,
  sublabel,
  selected,
  online,
  onPress,
}: {
  label: string;
  sublabel?: string;
  selected: boolean;
  online?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderBottomWidth: 1,
        borderBottomColor: "#1A1A1A",
      }}
    >
      <View
        style={{
          width: 18,
          height: 18,
          borderRadius: 9,
          borderWidth: 2,
          borderColor: selected ? CYAN : "#404040",
          alignItems: "center",
          justifyContent: "center",
          marginRight: 10,
        }}
      >
        {selected && (
          <View
            style={{
              width: 10,
              height: 10,
              borderRadius: 5,
              backgroundColor: CYAN,
            }}
          />
        )}
      </View>
      {online !== undefined && (
        <Text
          style={{
            fontSize: 8,
            color: online ? GREEN : "#EF4444",
            marginRight: 8,
          }}
        >
          {"\u25CF"}
        </Text>
      )}
      <View style={{ flex: 1 }}>
        <Text
          style={{
            color: "#E5E5E5",
            fontSize: 13,
            fontFamily: "monospace",
          }}
        >
          {label}
        </Text>
        {sublabel && (
          <Text
            style={{
              color: GRAY,
              fontSize: 10,
              fontFamily: "monospace",
              marginTop: 2,
            }}
          >
            {sublabel}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

function CheckboxOption({
  label,
  sublabel,
  checked,
  online,
  onPress,
}: {
  label: string;
  sublabel?: string;
  checked: boolean;
  online?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderBottomWidth: 1,
        borderBottomColor: "#1A1A1A",
      }}
    >
      <View
        style={{
          width: 18,
          height: 18,
          borderRadius: 4,
          borderWidth: 2,
          borderColor: checked ? CYAN : "#404040",
          backgroundColor: checked ? CYAN : "transparent",
          alignItems: "center",
          justifyContent: "center",
          marginRight: 10,
        }}
      >
        {checked && (
          <Text style={{ color: "#000", fontSize: 12, fontWeight: "bold", lineHeight: 14 }}>
            {"\u2713"}
          </Text>
        )}
      </View>
      {online !== undefined && (
        <Text
          style={{
            fontSize: 8,
            color: online ? GREEN : "#EF4444",
            marginRight: 8,
          }}
        >
          {"\u25CF"}
        </Text>
      )}
      <View style={{ flex: 1 }}>
        <Text
          style={{
            color: "#E5E5E5",
            fontSize: 13,
            fontFamily: "monospace",
          }}
        >
          {label}
        </Text>
        {sublabel && (
          <Text
            style={{
              color: GRAY,
              fontSize: 10,
              fontFamily: "monospace",
              marginTop: 2,
            }}
          >
            {sublabel}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

function StatusRow({
  label,
  value,
  valueColor = "#E5E5E5",
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        paddingVertical: 6,
        borderBottomWidth: 1,
        borderBottomColor: "#1A1A1A",
      }}
    >
      <Text
        style={{
          color: "#737373",
          fontSize: 12,
          fontFamily: "monospace",
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          color: valueColor,
          fontSize: 12,
          fontFamily: "monospace",
          fontWeight: "bold",
        }}
      >
        {value}
      </Text>
    </View>
  );
}

function deviceLabel(d: AudioDevice): string {
  return d.deviceId.replace(/^ozzu-/, "");
}

function deviceSublabel(d: AudioDevice): string {
  const parts = [d.deviceType];
  if (d.zone && d.zone !== "default") parts.push(d.zone);
  return parts.join(" / ");
}

export default function AudioRoutingScreen() {
  const router = useRouter();
  const { insets, isPhone } = usePhoneLayout();
  const [data, setData] = useState<AudioPreferences | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const result = await fetchAudioPreferences();
      setData(result);
      setError(null);
    } catch (err: any) {
      setError(err.message || "Failed to fetch audio preferences");
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadData();
      const interval = setInterval(loadData, 5000);
      return () => clearInterval(interval);
    }, [loadData])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }, [loadData]);

  const handleSetInput = useCallback(
    async (deviceId: string | null) => {
      setSaving(true);
      try {
        await setAudioPreferences({ preferredInput: deviceId });
        await loadData();
      } catch {}
      setSaving(false);
    },
    [loadData]
  );

  const handleToggleOutput = useCallback(
    async (deviceId: string | null) => {
      if (!data) return;
      setSaving(true);
      try {
        if (deviceId === null) {
          // "Auto" selected — clear all output preferences
          await setAudioPreferences({ preferredOutputs: null });
        } else {
          const current = data.preferredOutputs || [];
          const next = current.includes(deviceId)
            ? current.filter((id) => id !== deviceId)
            : [...current, deviceId];
          await setAudioPreferences({
            preferredOutputs: next.length > 0 ? next : null,
          });
        }
        await loadData();
      } catch {}
      setSaving(false);
    },
    [data, loadData]
  );

  const micDevices = data?.devices.filter((d) => d.capabilities?.mic) || [];
  const speakerDevices =
    data?.devices.filter((d) => d.capabilities?.speaker) || [];
  const isAutoOutput = !data?.preferredOutputs || data.preferredOutputs.length === 0;

  // Phone view: full control. Tablet/TV: read-only status
  const renderPhoneView = () => (
    <>
      {/* INPUT DEVICE */}
      <SectionHeader title="INPUT DEVICE" />
      <View
        style={{
          backgroundColor: CARD_BG,
          borderWidth: 1,
          borderColor: BORDER,
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        <RadioOption
          label="Auto"
          sublabel="Amplitude-gated mic switching"
          selected={!data?.preferredInput}
          onPress={() => handleSetInput(null)}
        />
        {micDevices.map((d) => (
          <RadioOption
            key={d.deviceId}
            label={deviceLabel(d)}
            sublabel={deviceSublabel(d)}
            selected={data?.preferredInput === d.deviceId}
            online={d.online}
            onPress={() => handleSetInput(d.deviceId)}
          />
        ))}
      </View>

      {/* OUTPUT DEVICES */}
      <SectionHeader title="OUTPUT DEVICES" />
      <View
        style={{
          backgroundColor: CARD_BG,
          borderWidth: 1,
          borderColor: BORDER,
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        <CheckboxOption
          label="Auto"
          sublabel="Priority-based speaker selection"
          checked={isAutoOutput}
          onPress={() => handleToggleOutput(null)}
        />
        {speakerDevices.map((d) => (
          <CheckboxOption
            key={d.deviceId}
            label={deviceLabel(d)}
            sublabel={deviceSublabel(d)}
            checked={data?.preferredOutputs?.includes(d.deviceId) || false}
            online={d.online}
            onPress={() => handleToggleOutput(d.deviceId)}
          />
        ))}
      </View>

      {/* LIVE STATUS */}
      <SectionHeader title="LIVE STATUS" />
      <View
        style={{
          backgroundColor: CARD_BG,
          borderWidth: 1,
          borderColor: BORDER,
          borderRadius: 8,
          padding: 12,
        }}
      >
        <StatusRow
          label="Active Mic"
          value={data?.activeMic?.replace(/^ozzu-/, "") || "none"}
          valueColor={data?.activeMic ? GREEN : GRAY}
        />
        <StatusRow
          label="Speaker Target"
          value={data?.autoSelectedSpeaker?.replace(/^ozzu-/, "") || "none"}
          valueColor={data?.autoSelectedSpeaker ? CYAN : GRAY}
        />
        <StatusRow
          label="Mode"
          value={data?.mode || "idle"}
          valueColor={
            data?.mode === "cipher"
              ? "#A78BFA"
              : data?.mode === "june"
              ? CYAN
              : GRAY
          }
        />
        <StatusRow
          label="Devices Online"
          value={`${data?.devices.filter((d) => d.online).length || 0} / ${data?.devices.length || 0}`}
        />
      </View>

      {/* CONNECTED DEVICES */}
      <SectionHeader title="CONNECTED DEVICES" />
      <View
        style={{
          backgroundColor: CARD_BG,
          borderWidth: 1,
          borderColor: BORDER,
          borderRadius: 8,
          padding: 12,
        }}
      >
        {data?.devices && data.devices.length > 0 ? (
          data.devices.map((d) => (
            <View
              key={d.deviceId}
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingVertical: 6,
                gap: 8,
              }}
            >
              <Text
                style={{
                  fontSize: 8,
                  color: d.online ? GREEN : "#EF4444",
                }}
              >
                {"\u25CF"}
              </Text>
              <Text
                style={{
                  color: "#A3A3A3",
                  fontSize: 12,
                  fontFamily: "monospace",
                  flex: 1,
                }}
              >
                {deviceLabel(d)}
              </Text>
              <Text
                style={{
                  color: GRAY,
                  fontSize: 10,
                  fontFamily: "monospace",
                }}
              >
                {d.isActiveMic ? "MIC " : ""}
                {d.isSelectedSpeaker ? "SPK " : ""}
                {d.deviceType}
              </Text>
            </View>
          ))
        ) : (
          <Text
            style={{
              color: GRAY,
              fontSize: 12,
              fontFamily: "monospace",
              textAlign: "center",
              paddingVertical: 8,
            }}
          >
            No devices connected
          </Text>
        )}
      </View>
    </>
  );

  const renderTabletView = () => (
    <>
      {/* THIS DEVICE */}
      <SectionHeader title="THIS DEVICE" />
      <View
        style={{
          backgroundColor: CARD_BG,
          borderWidth: 1,
          borderColor: BORDER,
          borderRadius: 8,
          padding: 12,
        }}
      >
        <StatusRow label="Type" value="tablet / speaker" />
        <StatusRow
          label="Receiving Audio"
          value={data?.autoSelectedSpeaker ? "yes" : "no"}
          valueColor={data?.autoSelectedSpeaker ? GREEN : GRAY}
        />
      </View>

      {/* CURRENT ROUTING */}
      <SectionHeader title="CURRENT ROUTING" />
      <View
        style={{
          backgroundColor: CARD_BG,
          borderWidth: 1,
          borderColor: BORDER,
          borderRadius: 8,
          padding: 12,
        }}
      >
        <StatusRow
          label="Input"
          value={data?.activeMic?.replace(/^ozzu-/, "") || "none"}
          valueColor={data?.activeMic ? GREEN : GRAY}
        />
        <StatusRow
          label="Output"
          value={data?.autoSelectedSpeaker?.replace(/^ozzu-/, "") || "none"}
          valueColor={data?.autoSelectedSpeaker ? CYAN : GRAY}
        />
        <StatusRow
          label="Mode"
          value={data?.mode || "idle"}
          valueColor={
            data?.mode === "cipher"
              ? "#A78BFA"
              : data?.mode === "june"
              ? CYAN
              : GRAY
          }
        />
        <StatusRow
          label="Devices Online"
          value={`${data?.devices.filter((d) => d.online).length || 0}`}
        />
      </View>

      {/* CONNECTED DEVICES */}
      <SectionHeader title="CONNECTED DEVICES" />
      <View
        style={{
          backgroundColor: CARD_BG,
          borderWidth: 1,
          borderColor: BORDER,
          borderRadius: 8,
          padding: 12,
        }}
      >
        {data?.devices && data.devices.length > 0 ? (
          data.devices.map((d) => (
            <View
              key={d.deviceId}
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingVertical: 6,
                gap: 8,
              }}
            >
              <Text style={{ fontSize: 8, color: d.online ? GREEN : "#EF4444" }}>
                {"\u25CF"}
              </Text>
              <Text
                style={{
                  color: "#A3A3A3",
                  fontSize: 12,
                  fontFamily: "monospace",
                  flex: 1,
                }}
              >
                {deviceLabel(d)}
              </Text>
              <Text
                style={{
                  color: GRAY,
                  fontSize: 10,
                  fontFamily: "monospace",
                }}
              >
                {d.isActiveMic ? "MIC " : ""}
                {d.isSelectedSpeaker ? "SPK " : ""}
                {d.deviceType}
              </Text>
            </View>
          ))
        ) : (
          <Text
            style={{
              color: GRAY,
              fontSize: 12,
              fontFamily: "monospace",
              textAlign: "center",
              paddingVertical: 8,
            }}
          >
            No devices connected
          </Text>
        )}
      </View>
    </>
  );

  return (
    <View style={{ flex: 1, backgroundColor: "#0A0A0A" }}>
      <StatusBar style="light" />

      {/* Top bar */}
      <View
        style={{
          height: TOP_BAR_HEIGHT + insets.top,
          paddingTop: insets.top,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
          borderBottomWidth: 1,
          borderBottomColor: "#1A1A1A",
        }}
      >
        <TVPressable
          onPress={() => router.back()}
          style={{ padding: 8, marginRight: 8 }}
        >
          <Text
            style={{
              color: GRAY,
              fontSize: 18,
              fontFamily: "monospace",
            }}
          >
            {"\u2190"}
          </Text>
        </TVPressable>
        <Text
          style={{
            color: CYAN,
            fontSize: 14,
            fontFamily: "monospace",
            fontWeight: "bold",
            letterSpacing: 3,
          }}
        >
          AUDIO
        </Text>
        <View style={{ flex: 1 }} />
        {saving && (
          <Text
            style={{
              color: CYAN,
              fontSize: 10,
              fontFamily: "monospace",
              marginRight: 8,
            }}
          >
            SAVING...
          </Text>
        )}
        <StatusBadge />
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: 16,
          paddingBottom: 40 + insets.bottom,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={CYAN}
          />
        }
      >
        {error && !data && (
          <Text
            style={{
              color: "#EF4444",
              fontSize: 12,
              fontFamily: "monospace",
              textAlign: "center",
              marginTop: 40,
            }}
          >
            {error}
          </Text>
        )}

        {!data && !error && (
          <Text
            style={{
              color: GRAY,
              fontSize: 12,
              fontFamily: "monospace",
              textAlign: "center",
              marginTop: 40,
            }}
          >
            Loading audio routing...
          </Text>
        )}

        {data && (isPhone ? renderPhoneView() : renderTabletView())}
      </ScrollView>
    </View>
  );
}
