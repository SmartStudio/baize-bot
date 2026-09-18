import { connect } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { databaseUrl } from "../env.js";

const { sql } = connect(databaseUrl(), { max: 1 });
try {
  const applied = await runMigrations(sql);
  console.log(
    applied.length === 0 ? "迁移已是最新，没有要跑的" : `应用了 ${applied.length} 个迁移: ${applied.join(", ")}`,
  );
} finally {
  await sql.end();
}
