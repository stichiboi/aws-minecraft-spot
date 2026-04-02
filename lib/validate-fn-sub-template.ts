/**
 * CloudFormation `Fn::Sub` parses every `${…}` in the string. Variable names must
 * be alphanumeric, `_`, `.`, or `:` only. Bash forms like `${VAR//x/y}` therefore
 * break deploy validation. `${!Name}` is the CFN escape for a literal `${Name}` in
 * the final script; the part after `!` follows the same character rules.
 *
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-sub.html
 */
const CFN_SUB_NAME = /^[A-Za-z0-9_.:]+$/;

/**
 * Returns human-readable issues found in `template` (raw shell as in repo / passed to `Fn.sub`).
 * Empty array means CloudFormation would accept the `${…}` usages for the given key map.
 */
export function findFnSubTemplateIssues(
  template: string,
  allowedSubstitutionKeys: ReadonlySet<string>
): string[] {
  const errors: string[] = [];
  const re = /\$\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    const inner = m[1];
    const offset = m.index;
    if (inner.startsWith("!")) {
      const literal = inner.slice(1);
      if (!CFN_SUB_NAME.test(literal)) {
        errors.push(
          `offset ${offset}: invalid \${!…} literal "${literal}" (Fn::Sub allows only [A-Za-z0-9_.:] — often bash expansion was used in a comment or string)`
        );
      }
    } else {
      if (!CFN_SUB_NAME.test(inner)) {
        errors.push(
          `offset ${offset}: invalid Fn::Sub name "${inner}" (forbidden characters — typical mistake: bash \${VAR//pattern/} or \${VAR:-default} in a template consumed by Fn::Sub)`
        );
      } else if (!allowedSubstitutionKeys.has(inner)) {
        errors.push(
          `offset ${offset}: unknown placeholder \${${inner}} (not in Fn::Sub map: ${[...allowedSubstitutionKeys].sort().join(", ")})`
        );
      }
    }
  }
  return errors;
}
