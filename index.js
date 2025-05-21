const app = require('./app.js');
app.listen(5000, () => {
  console.log('Server is running on port 5000. Access it using http://localhost:5000');
});

module.exports = app;