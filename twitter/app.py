import os
import time
import flask
import tweepy
from twitter import *
from flask import Flask, request, render_template
import base64
import hashlib
import hmac
import json


OAUTH_TOKEN="2464717370-ztIheNqKFIr9ll1ZG3OEa1SxRPTGY8k1XL3Ukj0"
OAUTH_SECRET="doEQPqBTLo22FrakNfY2q3jdLJyary6TFcLT8sv8AJes7"
CONSUMER_KEY="0J1e4CLZOLJTG1fVQaQya4fH1"
CONSUMER_SECRET="SUZK3xOyW4DJzY0rqr8pr2PQuVjEjEPgUNd73fMYd5eXSg4sY9"

app = Flask(__name__)

twitter = Twitter (
	auth=OAuth(OAUTH_TOKEN, OAUTH_SECRET, CONSUMER_KEY, CONSUMER_SECRET)
) 

#The GET method for webhook should be used for the CRC check
#TODO: add header validation (compare_digest https://docs.python.org/3.6/library/hmac.html)
@app.route("/webhook", methods=["GET"])
def twitterCrcValidation():
    
    crc = request.args['crc_token']
  
    validation = hmac.new(
        key=bytes(CONSUMER_SECRET, 'utf-8'),
        msg=bytes(crc, 'utf-8'),
        digestmod = hashlib.sha256
    )
    digested = base64.b64encode(validation.digest())
    response = {
        'response_token': 'sha256=' + format(str(digested)[2:-1])
    }
    print('responding to CRC call')

    return json.dumps(response)   
        
#The POST method for webhook should be used for all other API events
#TODO: add event-specific behaviours beyond Direct Message and Like
@app.route("/webhook", methods=["POST"])
def twitterEventReceived():
	  		
    requestJson = request.get_json()

    #dump to console for debugging purposes
    print(json.dumps(requestJson, indent=4, sort_keys=True))

@app.route('/')

def main():

	# fetch 3 tweets from my account
	mytweets = twitter.statuses.user_timeline(count=10, screen_name="CUhackit")

	# app.logger.debug(itpTweets)

	templateData = {
		'title' : 'My last three tweets',
		'mytweets' : mytweets,
	}

	return flask.render_template("index.html", **templateData)



# @app.route('/templates/')
# def index():
# 	return flask.render_template("index.html", **templateData)

if __name__ == '__main__':
	# auth = tweepy.OAuthHandler()

	app.debug=True
	app.run()


