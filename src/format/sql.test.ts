import { describe, expect, it } from "vitest";
import { firstDifference, formatSql, splitUnits, SqlStyle, tokenize } from "./sql";

const toad: SqlStyle = { dialect: "plsql", layout: "toad", keywordCase: "upper", indent: "   " };
const fmt = (s: string, style: Partial<SqlStyle> = {}) => formatSql(s, { ...toad, ...style });
const lines = (...l: string[]) => l.join("\n") + "\n";

describe("plain SQL, Toad layout", () => {
  it("right-aligns clause keywords and keeps column-like words as written", () => {
    expect(fmt("select * from adm_users where id = 1 and status in ('A','B') order by name")).toBe(
      lines("  SELECT *", "    FROM adm_users", "   WHERE id = 1", "     AND status IN ('A', 'B')", "ORDER BY name"),
    );
  });

  it("formats each statement on its own, aligned at column 0", () => {
    expect(fmt("update adm_users set active=0 where id=5; delete from adm_log where ts < sysdate - 30;")).toBe(
      lines("UPDATE adm_users", "   SET active = 0", " WHERE id = 5;", "", "DELETE FROM adm_log", " WHERE ts < SYSDATE - 30;"),
    );
  });

  it("uppercases Oracle functions, keeps identifiers and binds", () => {
    expect(fmt("select nvl(a.x,0), count(*) from t a where a.id = :p_id")).toBe(
      lines("SELECT NVL(a.x, 0),", "       COUNT(*)", "  FROM t a", " WHERE a.id = :p_id"),
    );
  });

  it("other layouts, cases and dialects", () => {
    expect(fmt("select a from t where b=1", { layout: "standard", indent: "  " })).toBe(lines("SELECT", "  a", "FROM", "  t", "WHERE", "  b = 1"));
    expect(fmt("SELECT A FROM T", { keywordCase: "lower" })).toBe(lines("select A", "  from T"));
    expect(fmt("select [order id] from dbo.[orders] where [x]=1", { dialect: "transactsql" })).toBe(
      lines("SELECT [order id]", "  FROM dbo.[orders]", " WHERE [x] = 1"),
    );
  });

  it("is idempotent", () => {
    const once = fmt("select a.id, b.name from a join b on a.id=b.id where a.x in (select y from z) order by 1");
    expect(fmt(once)).toBe(once);
  });
});

describe("PL/SQL blocks", () => {
  const proc = `create or replace procedure set_active(p_id in number) is
  v_cnt number := 0;
  cursor c is select id from adm_users where active = 'Y';
begin
  select count(*) into v_cnt from adm_users where id = p_id;
  if v_cnt = 0 then raise_application_error(-20001, 'not found: ' || p_id);
  elsif v_cnt > 1 then dbms_output.put_line('dup');
  else update adm_users set active = 'Y' where id = p_id;
  end if;
  for r in c loop dbms_output.put_line(r.id); end loop;
exception
  when others then rollback; raise;
end set_active;
/
select 1 from dual;`;

  it("indents blocks Toad-style and lays out the SQL inside", () => {
    expect(fmt(proc)).toBe(
      lines(
        "CREATE OR REPLACE PROCEDURE set_active(p_id IN NUMBER) IS",
        "   v_cnt NUMBER := 0;",
        "   CURSOR c IS",
        "      SELECT id",
        "        FROM adm_users",
        "       WHERE active = 'Y';",
        "BEGIN",
        "   SELECT COUNT(*) INTO v_cnt",
        "     FROM adm_users",
        "    WHERE id = p_id;",
        "   IF v_cnt = 0 THEN",
        "      RAISE_APPLICATION_ERROR(-20001, 'not found: ' || p_id);",
        "   ELSIF v_cnt > 1 THEN",
        "      dbms_output.put_line('dup');",
        "   ELSE",
        "      UPDATE adm_users",
        "         SET active = 'Y'",
        "       WHERE id = p_id;",
        "   END IF;",
        "   FOR r IN c LOOP",
        "      dbms_output.put_line(r.id);",
        "   END LOOP;",
        "EXCEPTION",
        "   WHEN OTHERS THEN",
        "      ROLLBACK;",
        "      RAISE;",
        "END set_active;",
        "/",
        "",
        "SELECT 1",
        "  FROM dual;",
      ),
    );
    expect(fmt(fmt(proc))).toBe(fmt(proc));
  });

  it("anonymous blocks, comments, CASE and WHILE", () => {
    const src = "declare x number; begin -- start\n x := 1; case x when 1 then null; else x := 2; end case; while x < 10 loop x := x + 1; end loop; end;\n/";
    expect(fmt(src)).toBe(
      lines(
        "DECLARE",
        "   x NUMBER;",
        "BEGIN",
        "   -- start",
        "   x := 1;",
        "   CASE x",
        "      WHEN 1 THEN",
        "         NULL;",
        "      ELSE",
        "         x := 2;",
        "   END CASE;",
        "   WHILE x < 10 LOOP",
        "      x := x + 1;",
        "   END LOOP;",
        "END;",
        "/",
      ),
    );
  });

  it("splits scripts into SQL and PL/SQL units at '/' lines", () => {
    const u = splitUnits("select 1 from dual;\nbegin null; end;\n/\nselect 2 from dual;");
    expect(u.map((x) => [x.plsql, x.text.trim()])).toEqual([
      [false, "select 1 from dual;"],
      [true, "begin null; end;"],
      [true, "/"],
      [false, "select 2 from dual;"],
    ]);
  });
});

describe("tokenizer and safety check", () => {
  it("keeps strings, quoted names and comments whole", () => {
    const t = tokenize("x := 'it''s' || q'[a'b]' /* c */ \"Mixed Name\" -- end").filter((x) => x.kind !== "ws");
    expect(t.map((x) => `${x.kind}:${x.text}`)).toEqual([
      "word:x",
      "op::=",
      "string:'it''s'",
      "op:||",
      "string:q'[a'b]'",
      "comment:/* c */",
      'quoted:"Mixed Name"',
      "comment:-- end",
    ]);
  });

  it("detects any real change, ignores spacing and keyword case", () => {
    expect(firstDifference("select a from t", "SELECT\n  a\nFROM t")).toBe(-1);
    expect(firstDifference("select 'a b' from t", "select 'a  b' from t")).toBe(1);
    expect(firstDifference("select a from t", "select b from t")).toBe(1);
    expect(firstDifference("select a from t;", "select a from t")).toBe(4);
  });

  it("never mangles string contents or comments", () => {
    const src = "select 'Don''t  touch  this', \"Odd  Col\" from t -- keep   spacing?\nwhere x = 1";
    const out = fmt(src);
    expect(out).toContain("'Don''t  touch  this'");
    expect(out).toContain('"Odd  Col"');
    expect(firstDifference(src, out)).toBe(-1);
  });
});
