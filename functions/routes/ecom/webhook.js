const axios = require('axios')
const { firestore } = require('firebase-admin')

// read configured E-Com Plus app data
const getAppData = require('./../../lib/store-api/get-app-data')

const SKIP_TRIGGER_NAME = 'SkipTrigger'
const ECHO_SUCCESS = 'SUCCESS'
const ECHO_SKIP = 'SKIP'
const ECHO_API_ERROR = 'STORE_API_ERR'

exports.post = ({ appSdk }, req, res) => {
  // receiving notification from Store API
  const { storeId } = req

  /**
   * Treat E-Com Plus trigger body here
   * Ref.: https://developers.e-com.plus/docs/api/#/store/triggers/
   */
  const trigger = req.body

  // get app configured options
  getAppData({ appSdk, storeId })

    .then(appData => {
      if (
        Array.isArray(appData.ignore_triggers) &&
        appData.ignore_triggers.indexOf(trigger.resource) > -1
      ) {
        // ignore current trigger
        const err = new Error()
        err.name = SKIP_TRIGGER_NAME
        throw err
      }

      /* DO YOUR CUSTOM STUFF HERE */
      const { resource } = trigger
      if ((resource === 'orders' || resource === 'carts') && trigger.action !== 'delete') {
        const resourceId = trigger.resource_id || trigger.inserted_id
        if (resourceId && appData.evendas_token) {
          const url = `https://api.e-vendas.net.br/api/padrao/ecomplus/${appData.evendas_token}`
          console.log(`Trigger for Store #${storeId} ${resourceId} => ${url}`)
          if (url) {
            appSdk.apiRequest(storeId, `${resource}/${resourceId}.json`)
              .then(async ({ response }) => {
                let customer
                if (resource === 'carts') {
                  const cart = response.data
                  if (cart.available && !cart.completed) {
                    const abandonedCartDelay = (appData.cart_delay || 0) * 1000 * 60
                    if (Date.now() - new Date(cart.created_at).getTime() >= abandonedCartDelay) {
                      const { customers } = cart
                      if (customers && customers[0]) {
                        const { response } = await appSdk.apiRequest(storeId, `customers/${customers[0]}.json`)
                        customer = response.data
                      }
                    } else {
                      const documentRef = firestore().doc(`cart_to_add/${cart._id}`)
                      const msDate = new Date().getTime() + abandonedCartDelay
                      await documentRef.set({
                        data: {
                          storeId,
                          trigger,
                          [resource.slice(0, -1)]: cart,
                          customer
                        },
                        url,
                        storeId,
                        sendAt: firestore.Timestamp.fromDate(new Date(msDate))
                      })
                      return res.send({
                        status: 400,
                        text: 'Waiting to send'
                      })
                    }
                  } else {
                    return res.sendStatus(204)
                  }
                }
                console.log(`> Sending ${resource} notification`)
                const data = {
                  storeId,
                  trigger,
                  [resource.slice(0, -1)]: response.data,
                  customer
                }
                if (storeId === 1445) {
                  console.log(JSON.stringify(data))
                }
                return axios({
                  method: 'post',
                  url,
                  data
                })
              })
              .then(({ status, data }) => console.log(`> ${status}`, JSON.stringify(data)))
              .catch(error => {
                if (error.response && error.config) {
                  const err = new Error(`#${storeId} ${resourceId} POST to ${url} failed`)
                  const { status, data } = error.response
                  err.response = {
                    status,
                    data: JSON.stringify(data)
                  }
                  err.data = JSON.stringify(error.config.data)
                  return console.error(err)
                }
                console.error(error)
              })
              .finally(() => {
                if (!res.headersSent) {
                  return res.sendStatus(200)
                }
              })
          }
        }
      }
    
      if (resource !== 'carts') {
        res.sendStatus(201)
      }
    })

    .catch(err => {
      if (err.name === SKIP_TRIGGER_NAME) {
        // trigger ignored by app configuration
        res.send(ECHO_SKIP)
      } else {
        // console.error(err)
        // request to Store API with error response
        // return error status code
        res.status(500)
        const { message } = err
        res.send({
          error: ECHO_API_ERROR,
          message
        })
      }
    })
}
