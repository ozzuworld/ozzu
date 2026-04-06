import { Redirect } from "expo-router";

// / maps here — redirect to directives tab (internal tab switch, safe on mount)
export default function Index() {
  return <Redirect href="/directives" />;
}
