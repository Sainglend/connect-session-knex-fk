# Connect Session Knex

connect-session-knex is a session store using [knex.js](http://knexjs.org/), which is a SQL query builder for Postgres, MySQL, MariaDB and SQLite3. Note: I could not get it to work with MariaDB using the mysql or mariadb drivers, but in general you're better off using PostgreSQL than MySQL.

## Installation

```sh
$ npm install connect-session-knex
```

## Options

 - `tablename='sessions'` Tablename to use. Defaults to 'sessions'.
 - `knex` knex instance to use. Defaults to a new knex instance, using sqlite3 with a file named 'connect-session-knex.sqlite'

## Usage

With express 4.x:

```js
var session = require('express-session');
var KnexSessionStore = require('connect-session-knex')(session);
var store = new KnexSessionStore(/* options here */);

app.use(session({
  store: store,
  secret: 'your secret',
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 1 week
}));
```

With express 3.x:

```js
var express = require('express')
var KnexSessionStore = require('connect-session-knex')(express);
var store = new KnexSessionStore(/* options here */);

app.configure(function() {
  app.use(express.session({
    store: store,
    secret: 'your secret',
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 1 week
  }));
});
```

With connect:

```js
var connect = require('connect'),
var KnexSessionStore = require('connect-session-knex')(connect);
var store = new KnexSessionStore(/* options here */);

connect.createServer(
  connect.cookieParser(),
  connect.session({
    store: store,
    secret: 'your secret'
  })
);
```


## Benchmarks

https://github.com/llambda/express-session-benchmarks
