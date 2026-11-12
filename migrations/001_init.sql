CREATE TABLE documents (
  document text PRIMARY KEY,
  book_id integer NOT NULL,
  book_file_id integer NOT NULL,
  resolved_at timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE clipping_revision;

CREATE TABLE clippings (
  book_file_id integer NOT NULL,
  clipping_id text NOT NULL,
  book_id integer NOT NULL,
  annotation_id integer,
  revision bigint NOT NULL DEFAULT nextval('clipping_revision'),
  deleted boolean NOT NULL DEFAULT false,
  spine integer NOT NULL DEFAULT 0,
  start_page integer NOT NULL DEFAULT 0,
  end_page integer NOT NULL DEFAULT 0,
  pages integer NOT NULL DEFAULT 1,
  start_word integer NOT NULL DEFAULT 0,
  end_word integer NOT NULL DEFAULT 0,
  words integer NOT NULL DEFAULT 0,
  para integer,
  chapter text NOT NULL DEFAULT '',
  text text NOT NULL DEFAULT '',
  created_at bigint NOT NULL DEFAULT 0,
  layout_signature bigint NOT NULL DEFAULT 0,
  start_offset bigint,
  end_offset bigint,
  PRIMARY KEY (book_file_id, clipping_id)
);

CREATE INDEX clippings_revision ON clippings (book_file_id, revision);
CREATE UNIQUE INDEX clippings_annotation ON clippings (book_file_id, annotation_id) WHERE annotation_id IS NOT NULL;
