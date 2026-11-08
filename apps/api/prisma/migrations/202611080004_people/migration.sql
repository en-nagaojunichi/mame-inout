-- 同じ利用者の編集・状態変更・QR再発行を版で区別し、古い画面の上書きを拒否する。
-- 既存行は初版として保持し、既存QR・在室・履歴・認証情報には触れない。
ALTER TABLE "Person" ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);
