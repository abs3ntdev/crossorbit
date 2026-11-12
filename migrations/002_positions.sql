CREATE TABLE positions (
  username text NOT NULL,
  document text NOT NULL,
  progress text NOT NULL,
  percentage double precision NOT NULL,
  position jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (username, document)
);
