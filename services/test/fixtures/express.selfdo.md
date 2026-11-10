index.js

```javascript
const express = require('express');

const app = express();
app.use(express.json());

let nextId = 1;
const todos = []; // in-memory storage

// GET /todos — full list
app.get('/todos', (req, res) => {
  res.json(todos);
});

// GET /todos/:id — one todo
app.get('/todos/:id', (req, res) => {
  const id = Number(req.params.id);
  const todo = todos.find((t) => t.id === id);
  if (!todo) {
    return res.status(404).json({ error: 'Todo not found' });
  }
  res.json(todo);
});

// POST /todos — create
app.post('/todos', (req, res) => {
  const { title } = req.body || {};
  if (typeof title !== 'string' || title.trim().length === 0) {
    return res.status(400).json({ error: 'Title is required and must be a non-empty string' });
  }
  const todo = { id: nextId++, title, completed: false };
  todos.push(todo);
  res.status(201).json(todo);
});

// PUT /todos/:id — update
app.put('/todos/:id', (req, res) => {
  const id = Number(req.params.id);
  const todo = todos.find((t) => t.id === id);
  if (!todo) {
    return res.status(404).json({ error: 'Todo not found' });
  }
  const { title, completed } = req.body || {};

  if (title !== undefined) {
    if (typeof title !== 'string' || title.trim().length === 0) {
      return res.status(400).json({ error: 'Title must be a non-empty string' });
    }
    todo.title = title;
  }
  if (completed !== undefined) {
    if (typeof completed !== 'boolean') {
      return res.status(400).json({ error: 'Completed must be a boolean' });
    }
    todo.completed = completed;
  }
  res.json(todo);
});

// DELETE /todos/:id — delete
app.delete('/todos/:id', (req, res) => {
  const id = Number(req.params.id);
  const index = todos.findIndex((t) => t.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'Todo not found' });
  }
  todos.splice(index, 1);
  res.status(204).send();
});

// 404 for unknown routes
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Central error handler (catches JSON parse errors, etc.)
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Todo API listening on port ${PORT}`);
});

module.exports = app;
```

package.json

```json
{
  "name": "todo-api",
  "version": "1.0.0",
  "description": "Small in-memory Express todo REST API",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "express": "^4.19.2"
  }
}
```

README.md

```markdown
# Todo API

A small in-memory REST API for todos, built with Express.

## Run

```bash
npm install
npm start
```

The server listens on `process.env.PORT` or port 3000 by default.

## Endpoints

| Method   | Path          | Description                                  |
| -------- | ------------- | -------------------------------------------- |
| GET      | /todos        | Return the full list of todos                |
| GET      | /todos/:id    | Return one todo (404 JSON error if missing)   |
| POST     | /todos        | Create a todo; body: `{"title": "..."}`      |
| PUT      | /todos/:id    | Update `title` and/or `completed`             |
| DELETE   | /todos/:id    | Delete a todo (204 on success, 404 if absent) |

## Examples

```bash
# Create a todo
curl -X POST http://localhost:3000/todos \
  -H "Content-Type: application/json" \
  -d '{"title": "Buy milk"}'

# List all todos
curl http://localhost:3000/todos

# Update a todo
curl -X PUT http://localhost:3000/todos/1 \
  -H "Content-Type: application/json" \
  -d '{"completed": true}'

# Delete a todo
curl -X DELETE http://localhost:3000/todos/1
```

Data is stored in memory and resets when the server restarts.
```

The API uses `express.json()` for body parsing and a central error handler so malformed JSON or bad input returns a clean JSON error instead of crashing the server.