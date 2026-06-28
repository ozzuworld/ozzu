import { useEffect, useRef, useState } from "react";
import { View, StyleSheet, type ViewStyle } from "react-native";
import { WebView } from "react-native-webview";
import { colors, withAlpha } from "../lib/design-tokens";

const LIVE2D_HTML = require("../assets/june/live2d.html");

interface Props {
  speaking?: boolean;
  style?: ViewStyle;
}

export function JuneAvatarLive2D({ speaking = false, style }: Props) {
  const webViewRef = useRef<WebView>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (ready && webViewRef.current) {
      webViewRef.current.injectJavaScript(`setSpeaking(${speaking}); true;`);
    }
  }, [speaking, ready]);

  return (
    <View style={[styles.container, style]}>
      <View style={styles.bgCircle}>
        <View style={styles.bgInner} />
      </View>
      <WebView
        ref={webViewRef}
        source={LIVE2D_HTML}
        style={styles.webview}
        scrollEnabled={false}
        bounces={false}
        allowsInlineMediaPlayback
        javaScriptEnabled
        originWhitelist={["*"]}
        onMessage={(event) => {
          try {
            const data = JSON.parse(event.nativeEvent.data);
            if (data.type === "ready") setReady(true);
          } catch {}
        }}
      />
      {speaking && <View style={styles.speakRing} />}
    </View>
  );
}

const FACE_SIZE = 220;

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    aspectRatio: 1,
  },
  bgCircle: {
    position: "absolute",
    width: FACE_SIZE + 60,
    height: FACE_SIZE + 60,
    borderRadius: (FACE_SIZE + 60) / 2,
    backgroundColor: withAlpha(colors.brand.purple, 0.08),
    alignItems: "center",
    justifyContent: "center",
  },
  bgInner: {
    width: FACE_SIZE + 30,
    height: FACE_SIZE + 30,
    borderRadius: (FACE_SIZE + 30) / 2,
    backgroundColor: withAlpha(colors.brand.purple, 0.12),
  },
  webview: {
    width: FACE_SIZE + 40,
    height: FACE_SIZE + 40,
    backgroundColor: "transparent",
  },
  speakRing: {
    position: "absolute",
    width: FACE_SIZE + 70,
    height: FACE_SIZE + 70,
    borderRadius: (FACE_SIZE + 70) / 2,
    borderWidth: 2,
    borderColor: withAlpha(colors.brand.cyan, 0.4),
  },
});
