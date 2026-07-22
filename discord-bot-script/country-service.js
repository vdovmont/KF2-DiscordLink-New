const net = require('net');

const IPINFO_BATCH_URL = 'https://api.ipinfo.io/batch/lite';
const MAX_BATCH_SIZE = 1000;
const UNKNOWN_COUNTRY_CODE = 'UNK';

// IPinfo returns ISO 3166-1 alpha-2 codes, while the KF2 protocol uses alpha-3.
// Kosovo (XK/XKX) is included as a commonly used user-assigned code.
const ISO_ALPHA_2_TO_3 = new Map(`
AD:AND AE:ARE AF:AFG AG:ATG AI:AIA AL:ALB AM:ARM AO:AGO AQ:ATA AR:ARG AS:ASM AT:AUT AU:AUS AW:ABW AX:ALA AZ:AZE
BA:BIH BB:BRB BD:BGD BE:BEL BF:BFA BG:BGR BH:BHR BI:BDI BJ:BEN BL:BLM BM:BMU BN:BRN BO:BOL BQ:BES BR:BRA BS:BHS BT:BTN BV:BVT BW:BWA BY:BLR BZ:BLZ
CA:CAN CC:CCK CD:COD CF:CAF CG:COG CH:CHE CI:CIV CK:COK CL:CHL CM:CMR CN:CHN CO:COL CR:CRI CU:CUB CV:CPV CW:CUW CX:CXR CY:CYP CZ:CZE
DE:DEU DJ:DJI DK:DNK DM:DMA DO:DOM DZ:DZA
EC:ECU EE:EST EG:EGY EH:ESH ER:ERI ES:ESP ET:ETH
FI:FIN FJ:FJI FK:FLK FM:FSM FO:FRO FR:FRA
GA:GAB GB:GBR GD:GRD GE:GEO GF:GUF GG:GGY GH:GHA GI:GIB GL:GRL GM:GMB GN:GIN GP:GLP GQ:GNQ GR:GRC GS:SGS GT:GTM GU:GUM GW:GNB GY:GUY
HK:HKG HM:HMD HN:HND HR:HRV HT:HTI HU:HUN
ID:IDN IE:IRL IL:ISR IM:IMN IN:IND IO:IOT IQ:IRQ IR:IRN IS:ISL IT:ITA
JE:JEY JM:JAM JO:JOR JP:JPN
KE:KEN KG:KGZ KH:KHM KI:KIR KM:COM KN:KNA KP:PRK KR:KOR KW:KWT KY:CYM KZ:KAZ
LA:LAO LB:LBN LC:LCA LI:LIE LK:LKA LR:LBR LS:LSO LT:LTU LU:LUX LV:LVA LY:LBY
MA:MAR MC:MCO MD:MDA ME:MNE MF:MAF MG:MDG MH:MHL MK:MKD ML:MLI MM:MMR MN:MNG MO:MAC MP:MNP MQ:MTQ MR:MRT MS:MSR MT:MLT MU:MUS MV:MDV MW:MWI MX:MEX MY:MYS MZ:MOZ
NA:NAM NC:NCL NE:NER NF:NFK NG:NGA NI:NIC NL:NLD NO:NOR NP:NPL NR:NRU NU:NIU NZ:NZL
OM:OMN
PA:PAN PE:PER PF:PYF PG:PNG PH:PHL PK:PAK PL:POL PM:SPM PN:PCN PR:PRI PS:PSE PT:PRT PW:PLW PY:PRY
QA:QAT
RE:REU RO:ROU RS:SRB RU:RUS RW:RWA
SA:SAU SB:SLB SC:SYC SD:SDN SE:SWE SG:SGP SH:SHN SI:SVN SJ:SJM SK:SVK SL:SLE SM:SMR SN:SEN SO:SOM SR:SUR SS:SSD ST:STP SV:SLV SX:SXM SY:SYR SZ:SWZ
TC:TCA TD:TCD TF:ATF TG:TGO TH:THA TJ:TJK TK:TKL TL:TLS TM:TKM TN:TUN TO:TON TR:TUR TT:TTO TV:TUV TW:TWN TZ:TZA
UA:UKR UG:UGA UM:UMI US:USA UY:URY UZ:UZB
VA:VAT VC:VCT VE:VEN VG:VGB VI:VIR VN:VNM VU:VUT
WF:WLF WS:WSM
XK:XKX
YE:YEM YT:MYT
ZA:ZAF ZM:ZMB ZW:ZWE
`.trim().split(/\s+/).map((pair) => pair.split(':')));

function isCountryByIpRequest(payload) {
  return Boolean(
    payload
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && payload.type === 'country_by_ip'
    && payload.subtype === 'request',
  );
}

function createUnknownCountryResponse(payload) {
  const entries = Array.isArray(payload?.ip) ? payload.ip : [];

  return {
    type: 'country_by_ip',
    subtype: 'response',
    ip: entries.map((entry) => ({
      value: entry?.value,
      countryCode: UNKNOWN_COUNTRY_CODE,
    })),
  };
}

function alpha2ToAlpha3(countryCode) {
  return ISO_ALPHA_2_TO_3.get(String(countryCode || '').trim().toUpperCase())
    || UNKNOWN_COUNTRY_CODE;
}

class CountryService {
  constructor({ token, timeoutMs = 10000, fetchImpl = globalThis.fetch } = {}) {
    this.token = String(token || '').trim();
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async resolveRequest(payload) {
    if (!isCountryByIpRequest(payload)) {
      throw new Error('Payload is not a country_by_ip request.');
    }

    if (!Array.isArray(payload.ip)) {
      throw new Error('country_by_ip request must contain an ip array.');
    }

    if (payload.ip.length > MAX_BATCH_SIZE) {
      throw new Error(`country_by_ip request exceeds the ${MAX_BATCH_SIZE}-address limit.`);
    }

    const response = createUnknownCountryResponse(payload);
    const normalizedIps = payload.ip.map((entry) =>
      typeof entry?.value === 'string' ? entry.value.trim() : '',
    );
    const uniqueValidIps = [...new Set(normalizedIps.filter((ip) => net.isIP(ip) !== 0))];

    if (uniqueValidIps.length === 0) {
      return response;
    }

    if (!this.token) {
      throw new Error('IPINFO_TOKEN is not configured.');
    }

    if (typeof this.fetchImpl !== 'function') {
      throw new Error('This Node.js version does not provide the Fetch API.');
    }

    const url = new URL(IPINFO_BATCH_URL);
    url.searchParams.set('token', this.token);
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.timeoutMs);
    let apiResponse;

    try {
      apiResponse = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(uniqueValidIps),
        signal: abortController.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      if (error?.name === 'AbortError') {
        throw new Error(`IPinfo request timed out after ${this.timeoutMs}ms.`);
      }

      throw new Error(`IPinfo request failed: ${error.message || error}`);
    }

    if (!apiResponse.ok) {
      clearTimeout(timeout);
      throw new Error(`IPinfo returned HTTP ${apiResponse.status}.`);
    }

    let lookupResults;
    try {
      lookupResults = await apiResponse.json();
    } catch (error) {
      throw new Error(`IPinfo returned invalid JSON: ${error.message || error}`);
    } finally {
      clearTimeout(timeout);
    }

    for (let index = 0; index < normalizedIps.length; index += 1) {
      const ip = normalizedIps[index];
      const lookup = lookupResults && typeof lookupResults === 'object'
        ? lookupResults[ip]
        : null;
      response.ip[index].countryCode = alpha2ToAlpha3(lookup?.country_code);
    }

    return response;
  }
}

module.exports = {
  CountryService,
  MAX_BATCH_SIZE,
  UNKNOWN_COUNTRY_CODE,
  alpha2ToAlpha3,
  createUnknownCountryResponse,
  isCountryByIpRequest,
};
