process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://c8bec00c0b5c44d7bc14c7cafd6fe43c@errors.cozycloud.cc/25'

const {
  BaseKonnector,
  requestFactory,
  scrape,
  log,
  utils,
} = require('cozy-konnector-libs')

const request = requestFactory({
  // The debug mode shows all the details about HTTP requests and responses.
  // Very useful for debugging but very verbose. This is why it is commented out by default
  // debug: true,

  // Activates [cheerio](https://cheerio.js.org/) parsing on each page
  cheerio: false,

  // If cheerio is activated, do not forget to deactivate json parsing
  // (which is activated by default in cozy-konnector-libs)
  json: false,

  // This allows request-promise to keep cookies between requests
  jar: true
})

const VENDOR = 'Gaz de Bordeaux (particuliers)'
const baseUrl = 'https://espaceclient.gazdebordeaux.fr'

module.exports = new BaseKonnector(start)


/**
 * The start function is run by the BaseKonnector instance only when it got all
 * the account information (fields).
 * @param {object} fields: When you run this connector yourself in "standalone" mode
 * or "dev" mode, the account information come from ./konnector-dev-config.json file.
 * @param {object} cozyParameters: static parameters, independents from the account.
 * Most often, it can be a secret api key.
*/
async function start(fields, cozyParameters) {

  log('info', 'Authenticating ...')
  if (cozyParameters) log('debug', 'Found COZY_PARAMETERS')
  await authenticate.bind(this)(fields.login, fields.password)
  log('info', 'Successfully logged in')

  log('info', 'Fetching the list of documents')
  // The requestFactory doesn't work well if cheerio is activated, and we get
  // the folowing message: "Please enable JavaScript to view the page content."
  // Therefore we need to:
  // - deactivate cheerio and json parsing (around lines 17-21)
  // - retrieve the html code and pass it to cheerio
  const html = await request(baseUrl + '/invoice')
  const $ = require('cheerio').load(html)
  const documents = await parseDocuments($)

  log('info', 'Saving data to Cozy')
  await this.saveBills(documents, fields, {
    // this is a bank identifier which will be used to link bills to bank operations. These
    // identifiers should be at least a word found in the title of a bank operation related to this
    // bill. It is not case sensitive.
    identifiers: ['Gaz de bordeaux'],
    // sourceAccount given to saveBills and saveFiles
    sourceAccount: fields.login,
    // deduplication keys used for file deduplication
    keys: ['vendorRef']
  })

}


// authentification using the website form
function authenticate(username, password) {

  return this.signin({

    // <form method="post" ... id="loginForm">
    url: `${baseUrl}/login`,
    formSelector: 'form#loginForm',

    // <input type="text" name="username">
    // <input type="password" name="password">
    // <input type="text" name="rememberMe" value="N">
    // <button type="submit" name="submitButton" value="Se&#x20;connecter">Se connecter</button>
    formData: {
      username: username,
      password: password,
      rememberMe: 'N',
      submitButton: 'Se connecter'
    },

    // The validate function will check if the login request was a success.
    // As gazdebordeaux.fr returns a statucode=200 even if the authentification
    // goes wrong, we need to check the message returned on the webpage.
    validate: (statusCode, $) => {
      const errorMsg1 = `Ce champ est obligatoire`
      const errorMsg2 = `Aucun compte ne correspond à l'identifiant et au mot de passe fournis`
      // <a href="/logout">Me déconnecter</a>
      if ($(`a[href='/logout']`).length === 1) {
        return true
      } else if ($.html().includes(errorMsg1)) {
        log('error', errorMsg1)
        return false
      } else if ($.html().includes(errorMsg2)) {
        log('error', errorMsg2)
        return false
      } else {
        log('error', 'erreur inconnue')
        return false
      }
    }
  })
}


// The goal of this function is to parse a HTML page wrapped by a cheerio instance
// and return an array of JS objects which will be saved to the cozy by saveBills
// (https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#savebills)
// cheerio (https://cheerio.js.org/) uses the same api as jQuery (http://jquery.com/)
function parseDocuments($) {

  // You can find documentation about the scrape function here:
  // https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#scrape
  const docs = scrape(
    $,
    {
      // The invoice date
      // <span class="invoice-code">20/10/2021</span>
      date: {
        sel: 'span.invoice-code',
        parse: normalizeDate
      },
      // The invoice amount
      // <span class="invoice-price">1474,49</span>
      amount: {
        sel: 'span.invoice-price',
        parse: normalizePrice
      },
      // The invoice reference
      // <ul class="plan-features"><li><em class="fa fa-barcode pull-left"></em>83254389</li>
      vendorRef: {
        sel: 'ul.plan-features li:first-child'
      },
      // The invoice url
      // <a href="/invoice/download?link=..." target="_blank" class="btn btn-info">
      fileurl: {
        sel: 'a.btn-info',
        attr: 'href',
        parse: formatFileurl
      }
    },
    // <form method="post" name="BillsForm" ...>
    // <div class="col-xs-12 col-sm-6 col-md-4 grid-item grid-year-2021">
    'form#BillsForm div.grid-item'
  )

  // on retourne chaque facture
  return docs
    .map(doc => ({
      ...doc,
      vendor: VENDOR,
      currency: 'EUR',
      filename: formatFilename(doc),
      type: 'gaz',
      fileAttributes: {
        metadata: {
          carbonCopy: true,
          classification: {
            label: 'energy_invoice',
            purpose: 'invoice',
            sourceCategory: 'energy'
          },
          datetime: utils.formatDate(doc.date),
          datetimeLabel: 'issueDate',
          contentAuthor: VENDOR,
          issueDate: utils.formatDate(doc.date)
        }
      }
    }))
}


/**
 * Converts a string formatted date (dd/mm/yyyy) into a JavaScript Date object
 * @param {string} date
 * @returns {object Date}
*/
function normalizeDate(date) {
  const [day, month, year] = date.split('/')
  // JavaScript counts months from 0 to 11.
  return new Date(year, month-1, day, 0, 0, 0)
}


/**
 * Converts a price string to a float
 * @param {string} price
 * @returns {float}
*/
function normalizePrice(price) {
  return parseFloat(price.replace(',', '.').trim())
}


/**
 * Formats a truncated invoice url to a full url
 * @param {string} url
 * @return {string}
*/
function formatFileurl(url) {
  return baseUrl+ url
}


/**
 * Formats the filename of the invoice based on its properties, such as:
 * 2020-01-01_gaz_de_bordeaux_facture_99.99EUR_12345678.pdf
 * @param {object} doc
 * @returns {string}
*/
function formatFilename(doc) {
  return `${utils.formatDate(doc.date)}_gaz_de_bordeaux_facture_${doc.amount.toFixed(2)}EUR_${doc.vendorRef}.pdf`
}
