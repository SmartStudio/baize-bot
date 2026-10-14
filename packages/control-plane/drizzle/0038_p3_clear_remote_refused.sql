-- 远程电脑也能登录了，remote_refused 不再是一种失败原因。两列一起清，满足 accounts_login_failure_ck。
UPDATE "accounts" SET "login_failure" = NULL, "login_failed_at" = NULL WHERE "login_failure" = 'remote_refused';
