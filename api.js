'use strict';

const axios = require('axios');
const config = require('./config');

const client = axios.create({
  baseURL: config.STRAPI_CONFIG.apiUrl
});

client.interceptors.request.use(req => {
  // Add Strapi token to all requests
  req.headers.authorization = `Bearer ${config.STRAPI_CONFIG.apiToken}`;
  return req;
});

client.interceptors.response.use(
  res => res,
  err => {
    if (err?.response?.data?.message) {
      throw new Error(err?.response?.data?.message);
    }
    throw err;
  }
);

module.exports = client;
