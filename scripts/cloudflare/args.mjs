// Normalize routing options once so guards, builds and uploads use the same target.
export function parseDeployArgs(input, inheritedProfile = process.env.KINIC_CF_PROFILE) {
  const args = [];
  const values = {};
  for (let i = 0; i < input.length; i++) {
    const token = input[i];
    const match = /^(--mode|--profile|-m)(?:=(.*))?$/.exec(token);
    if (!match) {
      args.push(token);
      continue;
    }
    const key = match[1] === "-m" ? "mode" : match[1].slice(2);
    const value = match[2] ?? input[++i];
    if (!value?.trim() || value.startsWith("-")) throw new Error(`--${key} requires a value`);
    if (values[key] !== undefined && values[key] !== value) throw new Error(`Conflicting --${key} values`);
    values[key] = value;
  }
  const profile = values.profile ?? inheritedProfile;
  if (values.mode !== undefined) args.push("--mode", values.mode);
  if (profile !== undefined) {
    if (!profile.trim() || profile.startsWith("-")) throw new Error("Invalid Cloudflare profile");
    args.push("--profile", profile);
  }
  return { args, mode: values.mode, profile };
}

export function profileArgs(profile) {
  return profile === undefined ? [] : ["--profile", profile];
}
