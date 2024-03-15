
//import the `image_cache` table as named in the schema.graphql
const { image_cache } = tables;

const { clustering } = server.config;
const DEFAULT_ORIGIN = 'usgm-az.walmart.com.akadns.net';

import {URL, fileURLToPath} from 'node:url';
import axios from 'axios';
import timer from '@szmarczak/http-timer';
import EdgeGrid from 'akamai-edgegrid';
import crypto from 'crypto';

import {performance} from 'perf_hooks';

const eg = new EdgeGrid({
  path: fileURLToPath(new URL('./.edgerc', import.meta.url))
});

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const SETTINGS = require("./settings.json");
//This value determines how long we will allow a record to be stale past the defined expiration
const STALE_WHILE_REVALIDATE = SETTINGS.staleToExpireBufferMS;
//this value allows us to define the fraction of the max-age to expire the record
const EXPIRE_PERCENT = SETTINGS.expirePercent;

import https from 'https';
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 301000
});

const transport = {
  request: function httpsWithTimer(...args) {
    const request = https.request.apply(null, args)
    timer(request);
    return request;
  }
};

server.http(async (request, next_handler) => {
  let response = await next_handler(request);
  response.headers?.set('HDB-Node-Name', clustering.nodeName);
  return response;
}, { runFirst: true });

//declare the base url
const BASE_URL = 'https://www-teflon.walmart.com.akadns.net/getImageHint';
const BASE_PATH = '/getImageHint';
const ALLOWED_NETWORKS = ['production', 'staging'];

/**
 * Class which instantiates timings specific to Cache invalidation
 */
class InvalidateCacheTimer {
  constructor() {
    this.harperdb_invalidation_time_start = 0;
    this.harperdb_invalidation_time_end = 0;
    this.harperdb_invalidation_count = 0;
    this.akamai_invalidation_time_start = 0;
    this.akamai_invalidation_time_end = 0;
    this.harperdb_invalidation_time_ms = 0;
    this.akamai_invalidation_time_ms = 0;
  }

  calculateTimes() {
    this.harperdb_invalidation_time_ms = this.harperdb_invalidation_time_end - this.harperdb_invalidation_time_start;
    this.akamai_invalidation_time_ms = this.akamai_invalidation_time_end - this.akamai_invalidation_time_start;
  }
}

/**
 * This class represents the RESTFUL export for the http(s)://.../getImageHint/... path
 */
export class getImageHint extends image_cache {
  allowRead () { return true }

  static parsePath(path) {
    if (path === '/' || path === '') return null;

    if(path.length > 659 && new Blob([path]).size > 1978 ) {
      return crypto.createHash('md5').update('some_string').digest("hex");
    }

    return path; // return the path as the id
  }

  async post(body) {
    let timer = new InvalidateCacheTimer();
    let context = this.getContext();

    //validate the body
    if(!body?.network || ALLOWED_NETWORKS.indexOf(body.network) < 0) {
      throw Error(`network property is required and have only one of allowed values: ${ALLOWED_NETWORKS}`);
    }

    let objects = body?.objects;
    if(!objects || !Array.isArray(objects) || objects.length < 1) {
      throw Error(`objects property is required and must be an Array with at least one entry`);
    }

    //convert the keys to our keys
    timer.harperdb_invalidation_time_start = performance.now();
    let aka_keys = [];
    for (const entry of objects) {
      let this_url = new URL({ toString: () => entry});

      let key = this_url.pathname;
      aka_keys.push(new URL(key, 'https://www.walmart.com').toString());
      key = key.replace('/getImageHint', '');

      await image_cache.invalidate(key);
    }
    timer.harperdb_invalidation_time_end = performance.now()
    timer.akamai_invalidation_time_start = performance.now();

    let akamai_response;
    try {
      akamai_response = await promisifyAkamai(`/ccu/v3/invalidate/url/${body.network}`, 'POST',
        {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        JSON.stringify({
          objects: aka_keys
        }));
    } catch (e) {
      akamai_response = e;
    }
    timer.akamai_invalidation_time_end = performance.now();

    timer.calculateTimes();

    let server_timing = `hdb_inval_ms;desc="ms for HDB to invalidate entries";dur=${timer.harperdb_invalidation_time_ms}, ` +
      `aka_inval_ms;desc="ms for Akamai to invalidate entries";dur=${timer.akamai_invalidation_time_ms}`;
    context.responseHeaders.set('Server-Timing', server_timing);
    server.recordAnalytics(timer.harperdb_invalidation_time_ms, 'hdb_inval', 'walmart_invalidate');
    server.recordAnalytics(timer.akamai_invalidation_time_ms, 'aka_inval', 'walmart_invalidate');

    return {
      akamai_response: akamai_response instanceof  Error ? akamai_response : JSON.parse(akamai_response)
    };
  }

  allowStaleWhileRevalidate(entry) {
    return Date.now() < entry.expiresAt + STALE_WHILE_REVALIDATE;
  }

  get() {
    if (this.cacheControl) {
      const context = this.getContext();
      context.responseHeaders.set('Cache-Control', this.cacheControl);
      this.cacheControl = undefined;
    }
    return super.get();
  }
}

function promisifyAkamai(aka_path, method, headers, body) {
  return new Promise(function(resolve, reject) {
    eg.auth({
      path: aka_path,
      method,
      headers,
      body
    }).send(function (error, response, body) {
      if(error) {
        reject(error)
      } else {
        resolve(body);
      }
    });
  });
}

//Create our extended resource class to handle the get which GETs from the origin
class ImageCacheResource extends Resource {

  UNSAFE_RESPONSE_HEADERS=['content-length', 'transfer-encoding', 'connection', 'vary',
    'content-encoding', 'keep-alive','proxy-authenticate', 'proxy-authorization', 'te', 'trailers','transfer-encoding',
    'upgrade', 'host', 'if-modified-since', 'accept', 'authorization'];

  invalidate() {
    super.invalidate();
  }
  async get() {
    let context = this.getContext();

    let request_path = context.requestContext.url;
    let domain;

    if(context.requestContext.headers.get('hdb-host')) {
      domain = context.requestContext.headers.get('hdb-host');
    } else {
      // If not origin is specified, we use the default origin. It is critical that we do NOT
      // use request `host` header, as that will create an infinite loop if the host header is our
      // own server.
      domain = DEFAULT_ORIGIN;
    }
//there were some instances where we were getting a comma separated list of values so adding logic to make this not cause a fail.
    if(domain.indexOf(',') >=0 ) {
      domain = domain.split(',')[0];
    }

    let url = `https://${domain}${request_path}`;

    let headers = {
      'X-Forwarded-Host': context.requestContext.headers.get('hdb-akam-host'),
      Host: context.requestContext.headers.get('hdb-akam-host')
    };

    for (const [key, value] of context.requestContext.headers) {
      if(this.UNSAFE_RESPONSE_HEADERS.indexOf(key) < 0 && typeof value !== 'function'){
        headers[key] = value;
      }
    }

    //intentionally commenting this out right now
    /*if(wmtHdbCache !== 'TcDENeBatk6VZ7SREVDmdXXr4piraIFY') {
      let error = new Error('Forbidden');
      error.statusCode = 403;
      throw error;
    }*/
    try {
      const response = await axios(url, {
        method: 'get',
        headers,
        httpsAgent,
        maxRedirects: 10,
        transport
      });
      let timing_header = processTimings(response?.request?.timings?.phases);

      context.requestContext.responseHeaders.set('Server-Timing', timing_header.join(', '));
      context.requestContext.responseHeaders.set('walmart-origin-status', response.status);
      server.recordAnalytics(true, 'walmart_origin_status', response.status);
      // cache the cache-control. It should be noted that this leads to wrong declarations
      // of max-age that are out of sync with the cached record's real expiration, but this is what
      // was requested.
      let cacheInfo = response.headers.get('Cache-Control');
      if (cacheInfo) {
        let maxAge = cacheInfo?.match(/max-age=(\d+)/)?.[1];

        if(maxAge === "0") {
          console.error(`received max-age 0 from origin: ${cacheInfo}`)
        }

        if (maxAge)
          // we can set a specific expiration time by setting context.expiresAt
          // we are converting from seconds to milliseconds, but we aren't using the full
          // max-age because we are using stale-while-revalidate, so this is the time until
          // we refresh from origin, but _not_ the time until we consider the record
          // fully expired and requiring revalidation _before_ returning it. So we kind
          // of split the difference here by setting it at 70% of the max-age
          context.expiresAt = Date.now() + maxAge * (1000 * EXPIRE_PERCENT);
        response.data.cacheControl = cacheInfo;
      }
      return response.data;
    }catch(e){
      let err = new Error();
      if (typeof e.response?.data === 'object') {
        err.contentType = 'application/json';
        err.data = JSON.stringify(e.response?.data);
      } else if (e.response?.headers.get('Content-Type')) {
        err.contentType = e.response?.headers.get('Content-Type');
        err.data = e.response?.data;
      }

      err.code = e.code;
      //we will not return 502 because it invokes walmart's retry logic
      err.statusCode = e.response?.status || 500;

      let timing_header = processTimings(e.request?.timings?.phases);
      context.requestContext.responseHeaders.set('walmart-origin-status', e?.response?.status);
      server.recordAnalytics(true, 'walmart_origin_status', e?.response?.status);
      context.requestContext.responseHeaders.set('Server-Timing', timing_header.join(', '));

      throw err;
    }

  }
}

function processTimings(timing) {
  let header_value = [];

  if(!timing) {
    return header_value;
  }

  if(timing?.wait !== undefined) {
    server.recordAnalytics(timing?.wait, "origin_wait", "walmart_origin");
    header_value.push(`origin_wait;desc="Time to establish socket";dur=${timing?.wait}`);
  }

  if(timing?.dns !== undefined) {
    server.recordAnalytics(timing?.dns, "origin_dns", "walmart_origin");
    header_value.push(`origin_dns;desc="Time for dns lookup";dur=${timing?.dns}`);
  }

  if(timing?.tcp !== undefined) {
    server.recordAnalytics(timing?.tcp, "origin_tcp", "walmart_origin");
    header_value.push(`origin_tcp;desc="Time for tcp connection";dur=${timing?.tcp}`);
  }

  if(timing?.tls !== undefined) {
    server.recordAnalytics(timing?.tls, "origin_tls", "walmart_origin");
    header_value.push(`origin_tls;desc="Time for tls handshake";dur=${timing?.tls}`);
  }

  if(timing?.request !== undefined) {
    server.recordAnalytics(timing?.request, "origin_request", "walmart_origin");
    header_value.push(`origin_request;desc="Time to transfer request";dur=${timing?.request}`);
  }

  if(timing?.firstByte !== undefined) {
    server.recordAnalytics(timing?.firstByte, "origin_firstByte", "walmart_origin");
    header_value.push(`origin_firstByte;desc="Time to first byte";dur=${timing?.firstByte}`);
  }

  if(timing?.download !== undefined) {
    server.recordAnalytics(timing?.download, "origin_download", "walmart_origin");
    header_value.push(`origin_download;desc="Time to download response";dur=${timing?.download}`);
  }

  if(timing?.total !== undefined) {
    server.recordAnalytics(timing?.total, "origin_total", "walmart_origin");
    header_value.push(`origin_total;desc="Total time of request";dur=${timing?.total}`);
  }
  return header_value;
}



//we need to declare that the table is sourcing from our declared class and will replicate
image_cache.sourcedFrom(ImageCacheResource, { replicationSource: true });

const INSTANCE_MAP = {
  atlanta01: '198.74.54.173',
  atlanta02:  '139.177.204.73',
  chicago01: '172.232.3.98',
  chicago02: '172.233.209.193',
  dallas01: '172.104.193.185',
  dallas02: '45.79.5.111',
  fremont01: '45.33.108.248',
  fremont02: '45.79.105.159',
  newark01: '69.164.214.205',
  newark02: '45.56.111.225',
  dc01: '139.144.207.169',
  dc02: '172.234.37.49',
  toronto01: '139.177.196.162',
  toronto02: '172.105.21.181',
  seattle01: '172.232.160.214',
  seattle02: '172.232.160.217'
};

const DATA_CENTER_ID_MAP = {
  2: 'dallas',
  3: 'atlanta',
  4: 'newark',
  5: 'toronto',
  6: 'dc',
  7: 'chicago',
  8: 'seattle',
  9: 'fremont',
};

const DATA_CENTER_NAME_MAP = Object.fromEntries(Object.entries(DATA_CENTER_ID_MAP).map(([k, v]) => [v, k]));

export class scaling extends  Resource {
  async get() {
    let json_result = await this.getDomainProperty();
    let targets = json_result?.trafficTargets;

    let provisioned = {};
    targets.forEach(target => {
      provisioned[DATA_CENTER_ID_MAP[target.datacenterId]] = {capacity: target.servers.length};
    });

    return provisioned;
  }

  update() {}

  async post(body){
    let targets = {};
    for (const [key, value] of Object.entries(body)) {
      let datacenter = key.toLowerCase();
      if(!DATA_CENTER_NAME_MAP[datacenter]) {
        throw new Error(`Incorrect data Center name '${datacenter}' must be one of ${Object.keys(DATA_CENTER_NAME_MAP).join(',')}`);
      }

      if([0,1,2].indexOf(value.capacity) < 0) {
        throw new Error(`Capacity is required and must be of numeric value: 0, 1, or 2`);
      }

      let servers = [];
      if(value.capacity === 1) {
        servers = [`${INSTANCE_MAP[datacenter+'01']}`];
      } else if(value.capacity === 2) {
        servers = [`${INSTANCE_MAP[datacenter+'01']}`, `${INSTANCE_MAP[datacenter+'02']}`];
      }

      targets[DATA_CENTER_NAME_MAP[datacenter]] = servers;
    }

    let property = await this.getDomainProperty();
    property.trafficTargets.forEach(target =>{
      let new_servers = targets[target.datacenterId];
      if(new_servers) {
        //only enable the target if we have entries in servers
        target.enabled = new_servers.length > 0
        target.servers = new_servers;
      }
    });

    await promisifyAkamai(`/config-gtm/v1/domains/${SETTINGS.akamaiDomain}/properties/${SETTINGS.akamaiDomainProperty}`, 'PUT', {
      'content-type': 'application/property-vnd-config-gtm.v1.5+json',
      'accept': 'application/property-vnd-config-gtm.v1.0+json'
    }, JSON.stringify(property));

    return 'Region capacities successfully updated.';
  }

  async getDomainProperty() {
    let aka_result = await promisifyAkamai(`/config-gtm/v1/domains/${SETTINGS.akamaiDomain}/properties/${SETTINGS.akamaiDomainProperty}`, 'GET', {
      'accept': 'application/property-vnd-config-gtm.v1.0+json'
    });
    return JSON.parse(aka_result);
  }
}