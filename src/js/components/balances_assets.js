ko.validation.rules['assetNameIsTaken'] = {
    async: true,
    message: 'Token name is already taken',
    validator: function(val, self, callback) {
        failoverAPI("get_issuances", { 'filters': { 'field': 'asset', 'op': '==', 'value': val } },
            function(data, endpoint) {
                return data.length ? callback(false) : callback(true) //empty list -> true (valid = true)
            }
        );
    }
};
// TODO: DRY!!
ko.validation.rules['assetNameExists'] = {
    async: true,
    message: 'Token name does not exist',
    validator: function(val, self, callback) {
        failoverAPI("get_issuances", { 'filters': { 'field': 'asset', 'op': '==', 'value': val } },
            function(data, endpoint) {
                $.jqlog.debug("Asset exists: " + data.length);
                return data.length ? callback(true) : callback(false) //empty list -> false (valid = false)
            }
        );
    }
};
ko.validation.rules['isValidAssetNameLength'] = {
    validator: function(val, self) {
        //Check length
        var n = 0;
        for (var i = 0; i < val.length; i++) {
            n *= 26;
            assert(B26_DIGITS.indexOf(val[i]) != -1); //should have been checked already
            n += B26_DIGITS.indexOf(val[i]);
        }
        assert(n >= Math.pow(26, 3)); //should have been checked already
        return n <= MAX_INT;
    },
    message: 'Asset name is too long, or too short'
};
ko.validation.rules['isValidAssetDescription'] = {
    validator: function(val, self) {
        return byteCount(val) <= MAX_ASSET_DESC_LENGTH;
    },
    message: 'Token description is more than ' + MAX_ASSET_DESC_LENGTH + ' bytes long.'
};
ko.validation.registerExtenders();

function CreateAssetModalViewModel() {
    var self = this;
    self.shown = ko.observable(false);
    self.address = ko.observable('');
    self.name = ko.observable('').extend({
        required: true,
        pattern: {
            message: "Must contain uppercase letters only (A-Z), be at least 4 characters in length, and cannot start with 'A'.",
            params: '^[B-Z][A-Z]{3,}$'
        },
        isValidAssetNameLength: self,
        assetNameIsTaken: self
    });
    self.description = ko.observable('').extend({
        required: false,
        isValidAssetDescription: self
    });
    self.divisible = ko.observable(true);
    self.quantity = ko.observable().extend({
        required: true,
        isValidPositiveQuantityOrZero: self,
        isValidQtyForDivisibility: self
    });
    self.callable = ko.observable(false);
    self.callDate = ko.observable(new Date(new Date().getTime() + 30 * 24 * 60 * 60 * 1000)).extend({
        //^ default to current date + 30 days for now (also serves to hide a bug with the required
        // field validation not working if this field is empty). This is temporary...
        date: true,
        required: {
            message: "Call date is required if the token is callable",
            onlyIf: function() { return (self.callable() === true); }
        }
    });
    self.callPrice = ko.observable(0).extend({
        required: {
            message: "Call price is required if the token is callable",
            onlyIf: function() { return (self.callable() === true); }
        },
        isValidPositiveQuantityOrZero: self
    });

    self.validationModel = ko.validatedObservable({
        name: self.name,
        description: self.description,
        quantity: self.quantity,
        callDate: self.callDate,
        callPrice: self.callPrice
    });

    self.resetForm = function() {
        self.name('');
        self.description('');
        self.divisible(true);
        self.quantity(null);
        self.validationModel.errors.showAllMessages(false);
    }

    self.submitForm = function() {
        if (self.name.isValidating()) {
            setTimeout(function() { //wait a bit and call again
                self.submitForm();
            }, 50);
            return;
        }

        if (!self.validationModel.isValid()) {
            self.validationModel.errors.showAllMessages();
            return false;
        }

        //data entry is valid...submit to the server
        $('#createAssetModal form').submit();
    }

    self.doAction = function() {
        var quantity = parseFloat(self.quantity());
        var rawQuantity = denormalizeQuantity(quantity, self.divisible());

        if (rawQuantity > MAX_INT) {
            bootbox.alert("The quantity desired to be issued for this token is too high.");
            return false;
        }

        if (self.callable() && self.callDate() <= new Date()) {
            bootbox.alert("Call date cannot be in the past.");
            return false;
        }

        WALLET.doTransaction(self.address(), "create_issuance", {
                source: self.address(),
                asset: self.name(),
                quantity: rawQuantity,
                divisible: self.divisible(),
                description: self.description(),
                callable_: self.callable(),
                call_date: self.callable() ? parseInt(self.callDate().getTime() / 1000) : null, //epoch ts
                call_price: self.callable() ? parseFloat(self.callPrice()) : null, //float
                transfer_destination: null
            },
            function(txHash, data, endpoint, addressType, armoryUTx) {
                var message = "Your token <b class='notoAssetColor'>" + self.name() + "</b> " +
                    (armoryUTx ? "will be created" : "has been created") + ".<br/><br/>" +
                    "It will automatically appear under the appropriate address once the network" +
                    " has confirmed it, and your address <b class='notoAddrColor'>" + getAddressLabel(self.address()) +
                    "</b> will be deducted by <b class='notoQuantityColor'>" + ASSET_CREATION_FEE_XCP + "</b> <b class='notoAssetColor'>" + XCP + "</b>. ";
                WALLET.showTransactionCompleteDialog(message + ACTION_PENDING_NOTICE, message, armoryUTx);
            }
        );
        self.shown(false);
        trackEvent('Assets', 'CreateAsset');
    }

    self.show = function(address, resetForm) {
        if (typeof(resetForm) === 'undefined') resetForm = true;
        if (resetForm) self.resetForm();
        self.address(address);
        self.shown(true);
        trackDialogShow('CreateAsset');
    }

    self.hide = function() {
        self.shown(false);
    }
}


function IssueAdditionalAssetModalViewModel() {
    var self = this;
    self.shown = ko.observable(false);
    self.address = ko.observable(''); // SOURCE address (supplied)
    self.divisible = ko.observable();
    self.asset = ko.observable();

    self.additionalIssue = ko.observable('').extend({
        required: true,
        isValidPositiveQuantity: self,
        isValidQtyForDivisibility: self,
        validation: {
            validator: function(val, self) {
                return self.rawAdditionalIssue() + self.asset().rawSupply() <= MAX_INT;
            },
            message: 'This issuance would exceed the hard limit for maximum quantity.',
            params: self
        }
    });

    self.dispTotalIssued = ko.computed(function() {
        if (!self.asset()) return null;
        return self.asset().dispTotalIssued();
    }, self);

    self.rawAdditionalIssue = ko.computed(function() {
        if (!self.asset() || !isNumber(self.additionalIssue())) return null;
        return denormalizeQuantity(self.additionalIssue(), self.asset().DIVISIBLE);
    }, self);

    self.validationModel = ko.validatedObservable({
        additionalIssue: self.additionalIssue
    });

    self.resetForm = function() {
        self.additionalIssue(null);
        self.validationModel.errors.showAllMessages(false);
    }

    self.submitForm = function() {
        if (!self.validationModel.isValid()) {
            self.validationModel.errors.showAllMessages();
            return false;
        }
        $('#issueAdditionalAssetModal form').submit();
    }

    self.doAction = function() {
        //do the additional issuance (specify non-zero quantity, no transfer destination)
        WALLET.doTransaction(self.address(), "create_issuance", {
                source: self.address(),
                quantity: self.rawAdditionalIssue(),
                asset: self.asset().ASSET,
                divisible: self.asset().DIVISIBLE,
                description: self.asset().description(),
                callable_: self.asset().CALLABLE,
                call_date: self.asset().CALLABLE ? self.asset().CALLDATE : 0,
                call_price: self.asset().CALLABLE ? self.asset().CALLPRICE : 0,
                transfer_destination: null
            },
            function(txHash, data, endpoint, addressType, armoryUTx) {
                self.shown(false);

                var message = "You " + (armoryUTx ? "will be issuing" : "have issued") + " <b class='notoQuantityColor'>" +
                    self.additionalIssue() + "</b> additional" + " quantity on your token <b class='notoAssetColor'>" +
                    self.asset().ASSET + "</b>. ";
                WALLET.showTransactionCompleteDialog(message + ACTION_PENDING_NOTICE, message, armoryUTx);
            }
        );
        trackEvent('Assets', 'IssueAdditionalAsset');
    }

    self.show = function(address, divisible, asset, resetForm) {
        if (typeof(resetForm) === 'undefined') resetForm = true;
        if (resetForm) self.resetForm();
        self.address(address);
        self.divisible(divisible);
        self.asset(asset);
        self.shown(true);
        trackDialogShow('IssueAdditionalAsset');
    }

    self.hide = function() {
        self.shown(false);
    }
}


function TransferAssetModalViewModel() {
    var self = this;
    self.shown = ko.observable(false);
    self.address = ko.observable(''); // SOURCE address (supplied)
    self.asset = ko.observable();

    self.destAddress = ko.observable('').trimmed().extend({
        required: true,
        isValidBitcoinAddress: self,
        isNotSameBitcoinAddress: self
    });

    self.validationModel = ko.validatedObservable({
        destAddress: self.destAddress
    });

    self.resetForm = function() {
        self.destAddress('');
        self.validationModel.errors.showAllMessages(false);
    }

    self.submitForm = function() {
        if (!self.validationModel.isValid()) {
            self.validationModel.errors.showAllMessages();
            return false;
        }
        $('#transferAssetModal form').submit();
    }

    self.doAction = function() {
        //do the transfer (zero quantity issuance to the specified address)
        WALLET.doTransaction(self.address(), "create_issuance", {
                source: self.address(),
                quantity: 0,
                asset: self.asset().ASSET,
                divisible: self.asset().DIVISIBLE,
                description: self.asset().description(),
                callable_: self.asset().CALLABLE,
                call_date: self.asset().CALLABLE ? self.asset().CALLDATE : 0,
                call_price: self.asset().CALLABLE ? self.asset().CALLPRICE : 0,
                transfer_destination: self.destAddress()
            },
            function(txHash, data, endpoint, addressType, armoryUTx) {
                self.shown(false);

                var message = "<b class='notoAssetColor'>" + self.asset().ASSET + "</b> " + (armoryUTx ? "will be" : "has been") +
                    " transferred to <b class='notoAddressColor'>" + self.destAddress() + "</b>. ";
                WALLET.showTransactionCompleteDialog(message + ACTION_PENDING_NOTICE, message, armoryUTx);
            }
        );
        trackEvent('Assets', 'TransferAsset');
    }

    self.show = function(sourceAddress, asset, resetForm) {
        if (typeof(resetForm) === 'undefined') resetForm = true;
        if (resetForm) self.resetForm();
        self.address(sourceAddress);
        self.asset(asset);
        self.shown(true);
        trackDialogShow('TransferAsset');
    }

    self.hide = function() {
        self.shown(false);
    }
}


function ChangeAssetDescriptionModalViewModel() {
    var self = this;
    self.shown = ko.observable(false);
    self.address = ko.observable(''); // SOURCE address (supplied)
    self.asset = ko.observable();

    self.newDescription = ko.observable('').extend({
        required: true,
        isValidAssetDescription: self,
        validation: {
            validator: function(val, self) {
                return self.newDescription() != self.asset().description();
            },
            message: 'This description is the same as the current description.',
            params: self
        },
        newDescIsNotSameAsCurrentDesc: self
    });

    self.dispAssetDescription = ko.computed(function() {
        return self.asset() ? self.asset().description() : '';
    }, self);

    self.dispCharactersRemaining = ko.computed(function() {
        if (!self.newDescription() || self.newDescription().length > MAX_ASSET_DESC_LENGTH) return '';
        return ' (<b>' + (MAX_ASSET_DESC_LENGTH - byteCount(self.newDescription())) + '</b> bytes remaining)';
    }, self);

    self.validationModel = ko.validatedObservable({
        newDescription: self.newDescription
    });

    self.resetForm = function() {
        self.newDescription('');
        self.validationModel.errors.showAllMessages(false);
    }

    self.submitForm = function() {
        if (!self.validationModel.isValid()) {
            self.validationModel.errors.showAllMessages();
            return false;
        }
        $('#changeAssetDescriptionModal form').submit();
    }

    self.doAction = function() {
        //to change the desc, issue with quantity == 0 and the new description in the description field
        WALLET.doTransaction(self.address(), "create_issuance", {
                source: self.address(),
                quantity: 0,
                asset: self.asset().ASSET,
                divisible: self.asset().DIVISIBLE,
                description: self.newDescription(),
                callable_: self.asset().CALLABLE,
                call_date: self.asset().CALLABLE ? self.asset().CALLDATE : 0,
                call_price: self.asset().CALLABLE ? self.asset().CALLPRICE : 0,
                transfer_destination: null
            },
            function(txHash, data, endpoint, addressType, armoryUTx) {
                self.shown(false);

                var message = "The description for token <b class='notoAssetColor'>" + self.asset().ASSET + "</b> " +
                    (armoryUTx ? "will be" : "has been") + " changed to <b>" + self.newDescription() + "</b>. ";
                WALLET.showTransactionCompleteDialog(message + ACTION_PENDING_NOTICE, message, armoryUTx);
            }
        );
        trackEvent('Assets', 'ChangeAssetDescription');
    }

    self.show = function(address, asset, resetForm) {
        if (typeof(resetForm) === 'undefined') resetForm = true;
        if (resetForm) self.resetForm();
        self.address(address);
        self.asset(asset);
        self.shown(true);
        trackDialogShow('ChangeAssetDescription');
    }

    self.hide = function() {
        self.shown(false);
    }
}
var AssetHistoryItemModel = function(historyObj) {
    var self = this;
    self.HISTORYOBJ = historyObj;

    self.dispBlockTime = function() {
        return moment(self.HISTORYOBJ['at_block_time']).format("M/D/YY h:mm:ssa");
    }

    self.dispDescription = function() {
        var desc = '';
        if (self.HISTORYOBJ['type'] == 'created') {
            desc = "Token created with description '<b>" + self.HISTORYOBJ['description'] +
                "</b>' and total issuance of <Am>" + numberWithCommas(self.HISTORYOBJ['total_issued_normalized']) + "</Am> units." +
                " Owned by address <Ad>" + getAddressLabel(self.HISTORYOBJ['owner']) + "</Ad>";
        } else if (self.HISTORYOBJ['type'] == 'issued_more') {
            desc = "An additional <Am>" + numberWithCommas(self.HISTORYOBJ['additional_normalized']) + "</Am> units issued." +
                " Total issuance increased to <Am>" + numberWithCommas(self.HISTORYOBJ['total_issued_normalized']) + "</Am> units";
        } else if (self.HISTORYOBJ['type'] == 'changed_description') {
            desc = "Description changed to '<b>" + self.HISTORYOBJ['new_description'] + "</b>'";
        } else if (self.HISTORYOBJ['type'] == 'locked') {
            desc = "Token locked";
        } else if (self.HISTORYOBJ['type'] == 'transferred') {
            desc = "Token transferred from address <Ad>" + getAddressLabel(self.HISTORYOBJ['prev_owner']) +
                "</Ad> to address <Ad>" + getAddressLabel(self.HISTORYOBJ['new_owner']) + "</Ad>";
        } else if (self.HISTORYOBJ['type'] == 'called_back') {
            desc = "<Am>" + self.HISTORYOBJ['percentage'] + "%</Am> of token called back";
        } else {
            desc = "UNKNOWN OP: <b>" + self.HISTORYOBJ['type'] + "</b>";
        }

        desc = desc.replace(/<Am>/g, '<b class="notoQuantityColor">').replace(/<\/Am>/g, '</b>');
        desc = desc.replace(/<Ad>/g, '<b class="notoAddrColor">').replace(/<\/Ad>/g, '</b>');
        return desc;
    }
};

function ShowAssetInfoModalViewModel() {
    var self = this;
    self.shown = ko.observable(false);
    self.address = ko.observable(null);
    self.asset = ko.observable(null);
    self.owner = ko.observable(null);
    self.description = ko.observable(null);
    self.totalIssued = ko.observable(null);
    self.locked = ko.observable(null);
    self.divisible = ko.observable(null);
    self.history = ko.observableArray([]);

    self.ext_info = ko.observableArray([]);
    self.extImageURL = ko.observable(null);
    self.extWebsite = ko.observable(null);
    self.extDescription = ko.observable(null);
    self.extPGPSigURL = ko.observable(null);

    self.dispTotalIssued = ko.computed(function() {
        return smartFormat(self.totalIssued());
    }, self);

    self.showHistory = ko.computed(function() {
        return self.history().length ? true : false;
    }, self);

    self.show = function(assetObj) {
        self.address(assetObj.ADDRESS);
        self.asset(assetObj.ASSET);
        self.owner(assetObj.owner());
        self.description(assetObj.description());
        self.totalIssued(assetObj.normalizedTotalIssued());
        self.locked(assetObj.locked());
        self.divisible(assetObj.DIVISIBLE);
        self.history([]); //clear until we have the data from the API call below...

        //Fetch the asset history and populate the table with it
        failoverAPI("get_asset_extended_info", { 'asset': assetObj.ASSET },
            function(ext_info, endpoint) {
                console.log(ext_info);
                if (!ext_info) {
                    console.log("No extended info returned for asset: " + assetObj.ASSET);
                    console.log(ext_info);
                    return; //asset has no extended info
                }

                if (ext_info.info_data.image)
                    self.extImageURL((USE_TESTNET ? '/_t_asset_img/' : '/_asset_img/') + assetObj.ASSET + '.png');

                self.extWebsite(ext_info.info_data.website);
                self.extDescription(ext_info.info_data.description);
                self.extPGPSigURL(ext_info.info_data.pgpsig);
            }
        );

        failoverAPI("get_asset_history", { 'asset': assetObj.ASSET, 'reverse': true },
            function(history, endpoint) {
                for (var i = 0; i < history.length; i++) {
                    self.history.push(new AssetHistoryItemModel(history[i]));
                }
            }
        );

        self.shown(true);
        trackDialogShow('ShowAssetInfo');
    }

    self.hide = function() {
        self.shown(false);
    }
}

/*NOTE: Any code here is only triggered the first time the page is visited. Put JS that needs to run on the
  first load and subsequent ajax page switches in the .html <script> tag*/