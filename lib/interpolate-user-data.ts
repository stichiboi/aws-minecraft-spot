/**
 * Replaces `${KEY}` placeholders in a shell script string.
 *
 * Values must be literal strings safe for bash. CDK tokens typed as `string`
 * are often objects at runtime; coercing them with `String.replace` embeds
 * `${Token[...]}` markers that bash mis-parses (see unit tests).
 */
export function interpolateUserDataScript(
  script: string,
  placeholders: Record<string, string>
): string {
  return Object.entries(placeholders).reduce(
    (acc, [key, val]) =>
      acc.replace(new RegExp(`\\$\\{${escapeRegExp(key)}\\}`, "g"), val),
    script
  );
}

function escapeRegExp(key: string): string {
  return key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * CloudFormation `Fn::Sub` treats `${Name}` as a variable; a literal `${bashVar}`
 * must be written `${!bashVar}` in the template. This reverses that for local
 * rendering (`buildUserDataBundle`, `render-user-data` CLI).
 */
export function stripCfnSubEscapes(script: string): string {
  return script.replace(/\$\{!([A-Za-z_][A-Za-z0-9_]*)\}/g, "${$1}");
}
