/** The connectors routed straight to the agent, in a fixed order. */
export function directConnectors(routes: { readonly gmail: string; readonly calendar: string }): string[] {
  return (["gmail", "calendar"] as const).filter(connector => routes[connector] === "direct" || routes[connector] === "both");
}
