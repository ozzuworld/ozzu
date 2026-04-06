import { Redirect } from "expo-router";

// Root URL "/" → redirect to directives tab
export default function Index() {
  return <Redirect href="/directives" />;
}
